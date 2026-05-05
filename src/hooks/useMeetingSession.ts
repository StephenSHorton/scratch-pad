import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import { formatChunkBatch } from "@/lib/aizuchi/batcher";
import {
	type Batch,
	consumeLiveStream,
	type FeederSignal,
	feedTranscriptBatches,
} from "@/lib/aizuchi/feeder";
import { standupTranscript } from "@/lib/aizuchi/fixtures/standup-transcript";
import { mutateGraph } from "@/lib/aizuchi/graph-mutation";
import { generateMeetingNotes } from "@/lib/aizuchi/meeting-notes";
import { proposeMeetingName } from "@/lib/aizuchi/name-generator";
import {
	buildSnapshot,
	type ExtractionMode,
	loadSnapshot,
	type MeetingSnapshot,
	type MeetingSource,
	newMeetingId,
	saveSnapshot,
} from "@/lib/aizuchi/persistence";
import {
	type AIThought,
	type AIThoughtRecord,
	applyDiff,
	emptyGraph,
	type Graph,
	mergeThoughts,
	type PassRecord,
	type TranscriptChunk,
} from "@/lib/aizuchi/schemas";

const SIZE_THRESHOLD_WORDS = 60;
const TIME_THRESHOLD_MS = 25_000;
// Live mode: any of three thresholds triggers a batch — first one wins.
// The chunk-count cap protects against sparse / quiet speech where the
// first two never fire. Tuned for snappy feedback over batch density.
const LIVE_SIZE_THRESHOLD_WORDS = 18;
const LIVE_TIME_THRESHOLD_MS = 7_000;
const LIVE_CHUNK_COUNT_THRESHOLD = 3;
const HIGHLIGHT_MS = 1500;
export const SPEED_MULTIPLIER = 4;
/** Sliding-window of transcript fed to the model for coreference / context. */
const RECENT_TRANSCRIPT_WINDOW_MS = 60_000;
/** Visible gap inserted between the last original chunk and the first
 * resumed chunk so the transcript stays monotonic and the boundary is
 * obvious in the live-transcript expand. */
const RESUME_GAP_MS = 1_000;

// AIZ-16 — meeting naming. Propose once enough signal exists, then opportunistically
// re-propose as the topic evolves. The "min batches" gate piggybacks on the
// existing batch loop instead of introducing a separate timer.
const NAME_MIN_TRANSCRIPT_MS = 30_000;
const NAME_MIN_BATCHES = 1;
const NAME_REPROPOSE_INTERVAL_MS = 60_000;
const NAME_REPROPOSE_MIN_BATCHES = 4;

export type Status =
	| "idle"
	| "listening"
	| "thinking"
	| "updated"
	| "paused"
	| "done"
	| "error"
	| "archived";

export type Mode = "idle" | "demo" | "live" | "import";

export interface RunStats {
	totalBatches: number;
	totalLatencyMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	providerLabel: string;
}

const INITIAL_STATS: RunStats = {
	totalBatches: 0,
	totalLatencyMs: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	providerLabel: "",
};

export interface MeetingSession {
	graph: Graph;
	status: Status;
	mode: Mode;
	batchIdx: number;
	transcript: TranscriptChunk[];
	passes: PassRecord[];
	error: string | null;
	stats: RunStats;
	highlightIds: ReadonlySet<string>;
	transcriptOpen: boolean;
	setTranscriptOpen: Dispatch<SetStateAction<boolean>>;
	generatingNotes: boolean;
	archivedAt: number | null;
	name: string | null;
	nameLockedByUser: boolean;
	setMeetingName: (name: string) => void;
	startDemo: () => Promise<void>;
	startLive: () => Promise<void>;
	resumeLive: () => Promise<void>;
	stopLive: () => Promise<void>;
	startImport: (
		chunks: TranscriptChunk[],
		sourceFile: string,
		extractionMode: ExtractionMode,
		source?: MeetingSource,
	) => Promise<void>;
	pauseDemo: () => void;
	resumeDemo: () => void;
	resetDemo: () => void;
	generateNotes: () => Promise<void>;
}

/**
 * The session hook. `meetingId` is the route's $id param.
 * - id === "test" → live/demo entry; never tries to load a snapshot
 * - any other id → tries `load_meeting(id)` on mount; on success the
 *   hook hydrates and switches to `archived` status (read-only viewing)
 */
export function useMeetingSession(meetingId: string): MeetingSession {
	const [graph, setGraph] = useState<Graph>(emptyGraph);
	const [status, setStatus] = useState<Status>("idle");
	const [batchIdx, setBatchIdx] = useState(0);
	const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [error, setError] = useState<string | null>(null);
	const [stats, setStats] = useState<RunStats>(INITIAL_STATS);
	const [transcript, setTranscript] = useState<TranscriptChunk[]>([]);
	const [transcriptOpen, setTranscriptOpen] = useState(false);
	const [passes, setPasses] = useState<PassRecord[]>([]);
	const [mode, setMode] = useState<Mode>("idle");
	const [generatingNotes, setGeneratingNotes] = useState(false);
	const [archivedAt, setArchivedAt] = useState<number | null>(null);
	const [name, setName] = useState<string | null>(null);
	const [nameLockedByUser, setNameLockedByUser] = useState(false);

	const consumedChunksRef = useRef(0);
	const thoughtsRef = useRef<AIThoughtRecord[]>([]);
	const transcriptRef = useRef<TranscriptChunk[]>([]);
	const graphRef = useRef<Graph>(emptyGraph());
	const passesRef = useRef<PassRecord[]>([]);
	const statsRef = useRef<RunStats>(INITIAL_STATS);
	const signalRef = useRef<FeederSignal>({ cancelled: false, paused: false });
	const runningRef = useRef(false);
	const modeRef = useRef<Mode>("idle");
	const meetingIdRef = useRef<string>(meetingId);
	const startedAtRef = useRef<number>(Date.now());
	// AIZ-16 — naming refs. Tracked alongside graph/transcript so the save path
	// and the proposer always see the latest values without waiting for state.
	const nameRef = useRef<string | null>(null);
	const nameLockedRef = useRef(false);
	const lastNameProposeAtRef = useRef(0);
	const lastNameProposeBatchRef = useRef(0);
	const namingInFlightRef = useRef(false);
	// AIZ-30 — origin tag for offline-import meetings. Set in startImport,
	// read by saveCurrentMeeting so the snapshot carries the source field.
	const sourceRef = useRef<MeetingSource | undefined>(undefined);
	const sourceFileRef = useRef<string | undefined>(undefined);
	// AIZ-32 — extraction mode for the active session. `undefined` outside of
	// import (live/demo run with the default attribution prompt today).
	const extractionModeRef = useRef<ExtractionMode | undefined>(undefined);
	// Holds the latest saveCurrentMeeting impl so the audio-phase listener
	// (registered once) can always call the current version.
	const saveCurrentMeetingRef = useRef<
		((savedMode: "demo" | "live") => Promise<string | null>) | null
	>(null);
	// Guards against double-saving when both stopLive and the audio-phase
	// listener fire for the same session. Reset on each new session start.
	const sessionSavedRef = useRef(false);

	useEffect(() => {
		return () => {
			signalRef.current.cancelled = true;
		};
	}, []);

	const recentTranscriptText = (): string => {
		const chunks = transcriptRef.current;
		if (chunks.length === 0) return "";
		const cutoff =
			(chunks[chunks.length - 1]?.endMs ?? 0) - RECENT_TRANSCRIPT_WINDOW_MS;
		const recent = chunks.filter((c) => c.endMs >= cutoff);
		return recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");
	};

	const pushChunk = (chunk: TranscriptChunk) => {
		transcriptRef.current = [...transcriptRef.current, chunk];
		setTranscript(transcriptRef.current);
	};

	const applyThoughts = (incoming: AIThought[]) => {
		thoughtsRef.current = mergeThoughts(
			thoughtsRef.current,
			incoming,
			Date.now(),
		);
	};

	// Refs are kept in lockstep with state so saveCurrentMeeting can read
	// the latest values without waiting for React's effect flush.
	const updateGraph = (g: Graph) => {
		graphRef.current = g;
		setGraph(g);
	};

	const updateStats = (s: RunStats) => {
		statsRef.current = s;
		setStats(s);
	};

	const recordPass = (
		idx: number,
		consumedChunks: number,
		thoughts: AIThought[],
	) => {
		const atChunkIdx = Math.max(consumedChunks - 1, 0);
		const next: PassRecord = {
			id: `pass-${idx}-${Date.now()}`,
			batchIdx: idx,
			atChunkIdx,
			thoughts,
			timestamp: Date.now(),
		};
		passesRef.current = [...passesRef.current, next];
		setPasses(passesRef.current);
	};

	const resetSessionState = (nextMode: Mode) => {
		setMode(nextMode);
		modeRef.current = nextMode;
		signalRef.current = { cancelled: false, paused: false };

		const startGraph = emptyGraph();
		graphRef.current = startGraph;
		passesRef.current = [];
		statsRef.current = INITIAL_STATS;
		transcriptRef.current = [];
		thoughtsRef.current = [];
		consumedChunksRef.current = 0;
		setGraph(startGraph);
		setBatchIdx(0);
		setHighlightIds(new Set());
		setError(null);
		setStats(INITIAL_STATS);
		setTranscript([]);
		setPasses([]);
		setArchivedAt(null);
		setStatus("listening");
		// AIZ-16 — clear naming state for a fresh session. Resume reuses
		// existing values and goes through resumeLive instead.
		nameRef.current = null;
		nameLockedRef.current = false;
		lastNameProposeAtRef.current = 0;
		lastNameProposeBatchRef.current = 0;
		namingInFlightRef.current = false;
		sourceRef.current = undefined;
		sourceFileRef.current = undefined;
		extractionModeRef.current = undefined;
		setName(null);
		setNameLockedByUser(false);
		return startGraph;
	};

	const saveCurrentMeeting = async (savedMode: "demo" | "live") => {
		// Skip empty meetings — clicking Stop right after Start shouldn't
		// litter the meetings dir.
		if (
			transcriptRef.current.length === 0 &&
			graphRef.current.nodes.length === 0
		) {
			return null;
		}
		try {
			const snap = buildSnapshot({
				id: meetingIdRef.current,
				mode: savedMode,
				startedAt: startedAtRef.current,
				graph: graphRef.current,
				thoughts: thoughtsRef.current,
				transcript: transcriptRef.current,
				passes: passesRef.current,
				stats: statsRef.current,
				name: nameRef.current ?? undefined,
				nameLockedByUser: nameLockedRef.current,
				source: sourceRef.current,
				sourceFile: sourceFileRef.current,
				extractionMode: extractionModeRef.current,
			});
			const id = await saveSnapshot(snap);
			console.log(`[meeting] saved snapshot ${id}`);
			return id;
		} catch (err) {
			console.error("[meeting] save failed", err);
			return null;
		}
	};

	const saveOnceForLive = async () => {
		if (sessionSavedRef.current) return;
		sessionSavedRef.current = true;
		await saveCurrentMeeting("live");
	};

	saveCurrentMeetingRef.current = saveCurrentMeeting;

	// Recording-session window has its own Stop button that calls
	// stop_live_capture directly, bypassing the meeting hook. Listen for
	// the resulting `audio-phase` "done" event so we still save the
	// snapshot when the user stops there.
	useEffect(() => {
		const unlistenPromise = listen<{ phase: string; label: string }>(
			"audio-phase",
			(event) => {
				if (event.payload.phase !== "done") return;
				if (modeRef.current !== "live") return;
				if (sessionSavedRef.current) return;
				sessionSavedRef.current = true;
				signalRef.current.cancelled = true;
				runningRef.current = false;
				const save = saveCurrentMeetingRef.current;
				const finish = () => {
					setMode("idle");
					modeRef.current = "idle";
					setStatus("done");
				};
				if (save) save("live").finally(finish);
				else finish();
			},
		);
		return () => {
			unlistenPromise.then((fn) => fn()).catch(() => {});
		};
	}, []);

	const hydrateFromSnapshot = (snap: MeetingSnapshot) => {
		meetingIdRef.current = snap.id;
		startedAtRef.current = snap.startedAt;
		graphRef.current = snap.graph;
		passesRef.current = snap.passes;
		statsRef.current = snap.stats;
		thoughtsRef.current = snap.thoughts;
		transcriptRef.current = snap.transcript;
		consumedChunksRef.current = snap.transcript.length;
		setGraph(snap.graph);
		setPasses(snap.passes);
		setStats(snap.stats);
		setTranscript(snap.transcript);
		setBatchIdx(snap.stats.totalBatches);
		const nextMode: Mode = snap.mode === "demo" ? "demo" : "live";
		setMode(nextMode);
		modeRef.current = nextMode;
		setStatus("archived");
		setArchivedAt(snap.endedAt);
		// AIZ-16 — restore naming state. Both fields are optional on disk.
		// Throttle counters reset to 0 so a resumed live session can re-propose
		// once enough new content lands (subject to the same gating thresholds).
		nameRef.current = snap.name ?? null;
		nameLockedRef.current = snap.nameLockedByUser ?? false;
		lastNameProposeAtRef.current = 0;
		lastNameProposeBatchRef.current = 0;
		namingInFlightRef.current = false;
		setName(snap.name ?? null);
		setNameLockedByUser(snap.nameLockedByUser ?? false);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: hydrateFromSnapshot only writes to refs and stable setState setters; including it would re-run the snapshot load on every render
	useEffect(() => {
		// "test" is reserved for the live/demo entry — never try to load
		// it as an archived snapshot.
		if (meetingId === "test") return;
		let cancelled = false;
		loadSnapshot(meetingId)
			.then((snap) => {
				if (cancelled) return;
				hydrateFromSnapshot(snap);
			})
			.catch((err) => {
				console.warn(`[meeting] no snapshot for ${meetingId}:`, err);
			});
		return () => {
			cancelled = true;
		};
	}, [meetingId]);

	// AIZ-16 — propose a meeting name when there's enough signal and we're
	// not locked. Called from runSession after each batch settles. Designed
	// to be cheap: bails fast when not eligible, and runs the LLM call
	// fire-and-forget so it never blocks the batch loop.
	const proposeNameIfStale = (idx: number) => {
		if (nameLockedRef.current) return;
		if (namingInFlightRef.current) return;
		if (idx < NAME_MIN_BATCHES) return;
		const transcript = transcriptRef.current;
		if (transcript.length === 0) return;
		const transcriptDurMs =
			(transcript[transcript.length - 1]?.endMs ?? 0) -
			(transcript[0]?.startMs ?? 0);
		if (transcriptDurMs < NAME_MIN_TRANSCRIPT_MS) return;

		const isFirst = nameRef.current == null;
		const now = Date.now();
		if (!isFirst) {
			// Re-propose throttle — wall-clock OR batch-count, whichever is
			// stricter. Piggybacks on the existing batch loop instead of a
			// separate setInterval.
			const sinceMs = now - lastNameProposeAtRef.current;
			const sinceBatches = idx - lastNameProposeBatchRef.current;
			if (
				sinceMs < NAME_REPROPOSE_INTERVAL_MS ||
				sinceBatches < NAME_REPROPOSE_MIN_BATCHES
			) {
				return;
			}
		}

		namingInFlightRef.current = true;
		lastNameProposeAtRef.current = now;
		lastNameProposeBatchRef.current = idx;

		// Snapshot inputs so a later batch mutating the graph mid-call
		// doesn't corrupt the prompt.
		const graphSnap = graphRef.current;
		const transcriptSnap = transcript.slice();

		proposeMeetingName(graphSnap, transcriptSnap)
			.then((proposal) => {
				// User may have locked or session may have ended while we waited.
				if (nameLockedRef.current) return;
				if (signalRef.current.cancelled) return;
				const proposed = proposal.name.trim();
				if (!proposed) return;
				if (proposed === nameRef.current) return;
				nameRef.current = proposed;
				setName(proposed);
				console.log(
					`[meeting-name] proposed "${proposed}" (${Math.round(proposal.latencyMs)}ms ${proposal.providerLabel})`,
				);
			})
			.catch((err) => {
				console.warn("[meeting-name] propose failed:", err);
			})
			.finally(() => {
				namingInFlightRef.current = false;
			});
	};

	const runSession = async (
		source: AsyncIterable<Batch>,
		nextMode: Exclude<Mode, "idle">,
		startGraph: Graph,
	) => {
		let current: Graph = startGraph;
		let idx = 0;
		const signal = signalRef.current;
		const isLive = nextMode === "live";
		const isImport = nextMode === "import";
		const dlog = isImport
			? (msg: string) =>
					invoke("log_from_frontend", { msg: `[import] ${msg}` }).catch(
						() => {},
					)
			: (_msg: string) => {};

		try {
			if (isLive) {
				console.log("[meeting-live] subscribing to transcript-chunk events…");
			}
			dlog("runSession: starting batch loop");
			for await (const batch of source) {
				if (isLive) {
					console.log(
						`[meeting-live] batch ${idx + 1}: ${batch.chunks.length} chunks, ${batch.wordCount} words`,
					);
				}
				dlog(
					`batch ${idx + 1}: ${batch.chunks.length} chunks, ${batch.wordCount} words`,
				);
				if (signal.cancelled) return;

				idx++;
				setBatchIdx(idx);
				setStatus("thinking");

				const result = await mutateGraph(current, formatChunkBatch(batch), {
					previousThoughts: thoughtsRef.current,
					recentTranscript: recentTranscriptText(),
					extractionMode: extractionModeRef.current,
				});
				if (signal.cancelled) return;

				if (isLive) {
					console.log(
						`[meeting-live] mutate ${idx}: no_changes=${result.diff.no_changes} +nodes=${result.diff.add_nodes.length} +edges=${result.diff.add_edges.length} ~nodes=${result.diff.update_nodes.length} merges=${result.diff.merge_nodes.length} -nodes=${result.diff.remove_nodes.length} -edges=${result.diff.remove_edges.length} thoughts=${result.diff.notes.length} (${Math.round(result.latencyMs)}ms ${result.providerLabel})`,
					);
				}

				const next = applyDiff(current, result.diff);
				const changed = new Set<string>();
				for (const n of result.diff.add_nodes) changed.add(n.id);
				for (const u of result.diff.update_nodes) changed.add(u.id);

				current = next;
				updateGraph(next);
				applyThoughts(result.diff.notes);
				consumedChunksRef.current += batch.chunks.length;
				recordPass(idx, consumedChunksRef.current, result.diff.notes);
				setHighlightIds(changed);
				setStatus("updated");
				updateStats({
					totalBatches: idx,
					totalLatencyMs: statsRef.current.totalLatencyMs + result.latencyMs,
					totalInputTokens:
						statsRef.current.totalInputTokens +
						(result.usage?.inputTokens ?? 0),
					totalOutputTokens:
						statsRef.current.totalOutputTokens +
						(result.usage?.outputTokens ?? 0),
					providerLabel: result.providerLabel,
				});

				// AIZ-16 — fire-and-forget; never blocks the batch loop.
				proposeNameIfStale(idx);

				await new Promise((r) => setTimeout(r, HIGHLIGHT_MS));
				if (signal.cancelled) return;
				setHighlightIds(new Set());
			}
			// Demo iterates a finite fixture and reaches "done"; live streams
			// indefinitely and is ended via stopLive(). Import is finite too —
			// persists as `mode: "live"` because the captured shape matches a
			// live meeting; `source` distinguishes the origin.
			if (!signal.cancelled && nextMode === "demo") {
				await saveCurrentMeeting("demo");
				setStatus("done");
			} else if (!signal.cancelled && nextMode === "import") {
				dlog(`loop done after ${idx} batches; saving snapshot`);
				const savedId = await saveCurrentMeeting("live");
				dlog(`saved snapshot id=${savedId ?? "<none>"}`);
				setMode("idle");
				modeRef.current = "idle";
				setStatus("done");
			}
		} catch (err) {
			if (signal.cancelled) return;
			console.error(
				isLive ? "Aizuchi live batch failed" : "Aizuchi batch failed",
				err,
			);
			const message = err instanceof Error ? err.message : String(err);
			dlog(`runSession error: ${message}`);
			setError(message);
			setStatus("error");
		} finally {
			runningRef.current = false;
		}
	};

	const startImport = async (
		chunks: TranscriptChunk[],
		sourceFile: string,
		extractionMode: ExtractionMode,
		source: MeetingSource = "transcript-import",
	) => {
		const dlog = (msg: string) =>
			invoke("log_from_frontend", { msg: `[import] ${msg}` }).catch(() => {});
		dlog(
			`startImport: chunks=${chunks.length} sourceFile=${sourceFile} mode=${extractionMode} source=${source}`,
		);
		if (runningRef.current) {
			dlog("startImport bailed: runningRef already true");
			return;
		}
		if (chunks.length === 0) {
			console.warn("[meeting-import] no chunks to import");
			return;
		}
		runningRef.current = true;
		const startGraph = resetSessionState("import");
		// AIZ-26 — adopt the route's `:id` so the IPC-allocated id and the
		// saved snapshot file line up. Same rationale as startDemo / startLive.
		meetingIdRef.current = meetingId === "test" ? newMeetingId() : meetingId;
		startedAtRef.current = Date.now();
		sessionSavedRef.current = false;
		sourceRef.current = source;
		sourceFileRef.current = sourceFile;
		extractionModeRef.current = extractionMode;
		dlog(`startImport ready: meetingId=${meetingIdRef.current}`);
		// `speedMultiplier: Infinity` zeroes out the pacing sleep — chunks
		// flow through batching as fast as the model returns. Existing batch
		// thresholds (size + simulated time) still apply, so each LLM call
		// gets a coherent slice rather than the whole transcript at once.
		// `onChunk: pushChunk` surfaces chunks in the transcript panel as
		// each batch flushes, mirroring the demo / live shape.
		const batches = feedTranscriptBatches(chunks, {
			sizeThresholdWords: SIZE_THRESHOLD_WORDS,
			timeThresholdMs: TIME_THRESHOLD_MS,
			speedMultiplier: Number.POSITIVE_INFINITY,
			signal: signalRef.current,
			onChunk: pushChunk,
		});
		await runSession(batches, "import", startGraph);
	};

	const startDemo = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		const startGraph = resetSessionState("demo");
		// AIZ-26 — adopt the route's `:id` so CLI flows
		// (`meeting start` → `meeting stop` / `meeting open`) line up with
		// the snapshot file on disk. Only mint a fresh id when the route is
		// the placeholder ("test"), which is what the palette / tray /
		// `dispatch_action("aizuchi")` paths use today (they open
		// `meeting/test` with no autostart and let the user click Start).
		meetingIdRef.current = meetingId === "test" ? newMeetingId() : meetingId;
		startedAtRef.current = Date.now();
		sessionSavedRef.current = false;
		const source = feedTranscriptBatches(standupTranscript, {
			sizeThresholdWords: SIZE_THRESHOLD_WORDS,
			timeThresholdMs: TIME_THRESHOLD_MS,
			speedMultiplier: SPEED_MULTIPLIER,
			signal: signalRef.current,
			onChunk: pushChunk,
		});
		await runSession(source, "demo", startGraph);
	};

	const _startLiveCore = async (opts: {
		startGraph: Graph;
		chunkOffsetMs: number;
	}) => {
		try {
			await invoke("start_live_capture");
		} catch (err) {
			console.error("start_live_capture failed", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
			runningRef.current = false;
			setMode("idle");
			modeRef.current = "idle";
			return;
		}

		const source = consumeLiveStream({
			sizeThresholdWords: LIVE_SIZE_THRESHOLD_WORDS,
			timeThresholdMs: LIVE_TIME_THRESHOLD_MS,
			chunkCountThreshold: LIVE_CHUNK_COUNT_THRESHOLD,
			chunkOffsetMs: opts.chunkOffsetMs,
			signal: signalRef.current,
			onChunk: (chunk) => {
				console.log(
					`[meeting-live] chunk: "${chunk.text}" (${chunk.startMs}-${chunk.endMs}ms)`,
				);
				pushChunk(chunk);
			},
		});
		await runSession(source, "live", opts.startGraph);
	};

	const startLive = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		const startGraph = resetSessionState("live");
		// AIZ-26 — adopt the route's `:id` (see `startDemo` for rationale).
		meetingIdRef.current = meetingId === "test" ? newMeetingId() : meetingId;
		startedAtRef.current = Date.now();
		sessionSavedRef.current = false;
		await _startLiveCore({ startGraph, chunkOffsetMs: 0 });
	};

	const resumeLive = async () => {
		if (runningRef.current) return;
		// Resume only makes sense for an archived live snapshot. Demo
		// resumes are out of scope (AIZ-19).
		if (status !== "archived" || modeRef.current !== "live") return;
		runningRef.current = true;

		// Keep meetingIdRef / startedAtRef pinned to the snapshot — same
		// file, same start time. Refs (graph / transcript / passes / stats /
		// thoughts) are already hydrated.
		signalRef.current = { cancelled: false, paused: false };
		// Reset the dedupe ref so the audio-phase: done listener can fire
		// the auto-save again on the next stop. Without this, the listener
		// would short-circuit because the previous live session set the ref
		// to true before archiving.
		sessionSavedRef.current = false;
		setError(null);
		setArchivedAt(null);
		setStatus("listening");

		// Compute the offset that the live feeder should add to incoming
		// chunks so they land *after* the existing transcript array.
		const lastChunk = transcriptRef.current[transcriptRef.current.length - 1];
		const lastEndMs = lastChunk?.endMs ?? 0;
		const chunkOffsetMs = lastEndMs + RESUME_GAP_MS;

		// Optional UX boundary marker — cheap, makes the resume point
		// obvious in the transcript expand. Mark with a clear comment so
		// it's easy to rip out if a UI-only separator is preferred.
		// --- BEGIN resume boundary marker (optional UX) ---
		if (lastChunk) {
			const now = new Date();
			const hh = now.getHours().toString().padStart(2, "0");
			const mm = now.getMinutes().toString().padStart(2, "0");
			pushChunk({
				speaker: "—",
				text: `(resumed at ${hh}:${mm})`,
				startMs: lastEndMs,
				endMs: lastEndMs + RESUME_GAP_MS,
			});
		}
		// --- END resume boundary marker ---

		await _startLiveCore({ startGraph: graphRef.current, chunkOffsetMs });
	};

	const pauseDemo = () => {
		if (!runningRef.current) return;
		signalRef.current.paused = true;
		setStatus("paused");
	};

	const resumeDemo = () => {
		if (!runningRef.current) return;
		signalRef.current.paused = false;
		setStatus("listening");
	};

	const stopLive = async () => {
		signalRef.current.cancelled = true;
		runningRef.current = false;
		await invoke("stop_live_capture").catch(() => {});
		await saveOnceForLive();
		setMode("idle");
		modeRef.current = "idle";
		setStatus("done");
	};

	const resetDemo = () => {
		// Archived view: Reset is repurposed to "Close" — close the meeting window.
		if (status === "archived") {
			getCurrentWindow().close().catch(() => {});
			return;
		}
		signalRef.current.cancelled = true;
		signalRef.current.paused = false;
		runningRef.current = false;
		if (modeRef.current === "live") {
			invoke("stop_live_capture").catch(() => {});
		}
		setMode("idle");
		modeRef.current = "idle";
		const empty = emptyGraph();
		graphRef.current = empty;
		passesRef.current = [];
		statsRef.current = INITIAL_STATS;
		transcriptRef.current = [];
		thoughtsRef.current = [];
		consumedChunksRef.current = 0;
		setGraph(empty);
		setBatchIdx(0);
		setHighlightIds(new Set());
		setError(null);
		setStats(INITIAL_STATS);
		setTranscript([]);
		setPasses([]);
		setArchivedAt(null);
		setStatus("idle");
		// AIZ-16 — reset naming state alongside everything else.
		nameRef.current = null;
		nameLockedRef.current = false;
		lastNameProposeAtRef.current = 0;
		lastNameProposeBatchRef.current = 0;
		namingInFlightRef.current = false;
		setName(null);
		setNameLockedByUser(false);
	};

	// AIZ-16 — public setter. User-typed name locks the AI naming loop.
	const setMeetingName = (next: string) => {
		const trimmed = next.trim();
		if (!trimmed) return;
		nameRef.current = trimmed;
		nameLockedRef.current = true;
		setName(trimmed);
		setNameLockedByUser(true);
	};

	const generateNotes = async () => {
		if (generatingNotes) return;
		setGeneratingNotes(true);
		const previousStatus = status;
		setStatus("thinking");
		setError(null);
		try {
			const result = await generateMeetingNotes(
				graph,
				thoughtsRef.current,
				transcriptRef.current,
			);
			console.log(
				`[meeting-notes] generated in ${Math.round(result.latencyMs)}ms via ${result.providerLabel}`,
			);
			await invoke("create_note", {
				title: result.title,
				body: result.body,
				color: "blue",
			});
			setStatus(previousStatus);
		} catch (err) {
			console.error("generateMeetingNotes failed", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		} finally {
			setGeneratingNotes(false);
		}
	};

	return {
		graph,
		status,
		mode,
		batchIdx,
		transcript,
		passes,
		error,
		stats,
		highlightIds,
		transcriptOpen,
		setTranscriptOpen,
		generatingNotes,
		archivedAt,
		name,
		nameLockedByUser,
		setMeetingName,
		startDemo,
		startLive,
		resumeLive,
		stopLive,
		startImport,
		pauseDemo,
		resumeDemo,
		resetDemo,
		generateNotes,
	};
}
