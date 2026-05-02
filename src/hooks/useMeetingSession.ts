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
import {
	buildSnapshot,
	loadSnapshot,
	type MeetingSnapshot,
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

export type Status =
	| "idle"
	| "listening"
	| "thinking"
	| "updated"
	| "paused"
	| "done"
	| "error"
	| "archived";

export type Mode = "idle" | "demo" | "live";

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
	startDemo: () => Promise<void>;
	startLive: () => Promise<void>;
	resumeLive: () => Promise<void>;
	stopLive: () => Promise<void>;
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
	const outlineLabel = `meeting-outline-${meetingId}`;

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

	const emitGraph = (g: Graph) => {
		getCurrentWindow()
			.emitTo(outlineLabel, "graph-update", g)
			.catch(() => {});
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
		emitGraph(startGraph);
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
		// The outline window may mount after us — retry the graph emit a
		// few times so it picks up the saved state regardless of order.
		[200, 700, 1500].forEach((d) =>
			setTimeout(() => emitGraph(snap.graph), d),
		);
	};

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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [meetingId]);

	const runSession = async (
		source: AsyncIterable<Batch>,
		nextMode: Exclude<Mode, "idle">,
		startGraph: Graph,
	) => {
		let current: Graph = startGraph;
		let idx = 0;
		const signal = signalRef.current;
		const isLive = nextMode === "live";

		try {
			if (isLive) {
				console.log("[meeting-live] subscribing to transcript-chunk events…");
			}
			for await (const batch of source) {
				if (isLive) {
					console.log(
						`[meeting-live] batch ${idx + 1}: ${batch.chunks.length} chunks, ${batch.wordCount} words`,
					);
				}
				if (signal.cancelled) return;

				idx++;
				setBatchIdx(idx);
				setStatus("thinking");

				const result = await mutateGraph(current, formatChunkBatch(batch), {
					previousThoughts: thoughtsRef.current,
					recentTranscript: recentTranscriptText(),
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
				emitGraph(next);
				applyThoughts(result.diff.notes);
				consumedChunksRef.current += batch.chunks.length;
				recordPass(idx, consumedChunksRef.current, result.diff.notes);
				setHighlightIds(changed);
				setStatus("updated");
				updateStats({
					totalBatches: idx,
					totalLatencyMs: statsRef.current.totalLatencyMs + result.latencyMs,
					totalInputTokens:
						statsRef.current.totalInputTokens + (result.usage?.inputTokens ?? 0),
					totalOutputTokens:
						statsRef.current.totalOutputTokens +
						(result.usage?.outputTokens ?? 0),
					providerLabel: result.providerLabel,
				});

				await new Promise((r) => setTimeout(r, HIGHLIGHT_MS));
				if (signal.cancelled) return;
				setHighlightIds(new Set());
			}
			// Demo iterates a finite fixture and reaches "done"; live streams
			// indefinitely and is ended via stopLive().
			if (!signal.cancelled && nextMode === "demo") {
				await saveCurrentMeeting("demo");
				setStatus("done");
			}
		} catch (err) {
			if (signal.cancelled) return;
			console.error(
				isLive ? "Aizuchi live batch failed" : "Aizuchi batch failed",
				err,
			);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		} finally {
			runningRef.current = false;
		}
	};

	const startDemo = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		const startGraph = resetSessionState("demo");
		meetingIdRef.current = newMeetingId();
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
		meetingIdRef.current = newMeetingId();
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

	const closeMeetingWindows = () => {
		const win = getCurrentWindow();
		win.emitTo(outlineLabel, "meeting-close", null).catch(() => {});
		win.close().catch(() => {});
	};

	const resetDemo = () => {
		// Archived view: Reset is repurposed to "Close" — close the
		// meeting + outline windows for this id.
		if (status === "archived") {
			closeMeetingWindows();
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
		emitGraph(empty);
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
		startDemo,
		startLive,
		resumeLive,
		stopLive,
		pauseDemo,
		resumeDemo,
		resetDemo,
		generateNotes,
	};
}
