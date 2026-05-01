import { invoke } from "@tauri-apps/api/core";
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

export type Status =
	| "idle"
	| "listening"
	| "thinking"
	| "updated"
	| "paused"
	| "done"
	| "error";

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
	startDemo: () => Promise<void>;
	startLive: () => Promise<void>;
	stopLive: () => Promise<void>;
	pauseDemo: () => void;
	resumeDemo: () => void;
	resetDemo: () => void;
	generateNotes: () => Promise<void>;
}

export function useMeetingSession(): MeetingSession {
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

	const consumedChunksRef = useRef(0);
	const thoughtsRef = useRef<AIThoughtRecord[]>([]);
	const transcriptRef = useRef<TranscriptChunk[]>([]);
	const signalRef = useRef<FeederSignal>({ cancelled: false, paused: false });
	const runningRef = useRef(false);
	const modeRef = useRef<Mode>("idle");

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

	const recordPass = (
		idx: number,
		consumedChunks: number,
		thoughts: AIThought[],
	) => {
		const atChunkIdx = Math.max(consumedChunks - 1, 0);
		setPasses((p) => [
			...p,
			{
				id: `pass-${idx}-${Date.now()}`,
				batchIdx: idx,
				atChunkIdx,
				thoughts,
				timestamp: Date.now(),
			},
		]);
	};

	const emitGraph = (g: Graph) => {
		getCurrentWindow()
			.emitTo("meeting-outline-test", "graph-update", g)
			.catch(() => {});
	};

	const resetSessionState = (nextMode: Mode) => {
		setMode(nextMode);
		modeRef.current = nextMode;
		signalRef.current = { cancelled: false, paused: false };

		const startGraph = emptyGraph();
		setGraph(startGraph);
		setBatchIdx(0);
		setHighlightIds(new Set());
		setError(null);
		setStats(INITIAL_STATS);
		transcriptRef.current = [];
		setTranscript([]);
		thoughtsRef.current = [];
		setPasses([]);
		consumedChunksRef.current = 0;
		setStatus("listening");
		emitGraph(startGraph);
		return startGraph;
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
				setGraph(next);
				emitGraph(next);
				applyThoughts(result.diff.notes);
				consumedChunksRef.current += batch.chunks.length;
				recordPass(idx, consumedChunksRef.current, result.diff.notes);
				setHighlightIds(changed);
				setStatus("updated");
				setStats((s) => ({
					totalBatches: idx,
					totalLatencyMs: s.totalLatencyMs + result.latencyMs,
					totalInputTokens:
						s.totalInputTokens + (result.usage?.inputTokens ?? 0),
					totalOutputTokens:
						s.totalOutputTokens + (result.usage?.outputTokens ?? 0),
					providerLabel: result.providerLabel,
				}));

				await new Promise((r) => setTimeout(r, HIGHLIGHT_MS));
				if (signal.cancelled) return;
				setHighlightIds(new Set());
			}
			// Demo iterates a finite fixture and reaches "done"; live streams
			// indefinitely and is ended via stopLive().
			if (!signal.cancelled && nextMode === "demo") setStatus("done");
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
		const source = feedTranscriptBatches(standupTranscript, {
			sizeThresholdWords: SIZE_THRESHOLD_WORDS,
			timeThresholdMs: TIME_THRESHOLD_MS,
			speedMultiplier: SPEED_MULTIPLIER,
			signal: signalRef.current,
			onChunk: pushChunk,
		});
		await runSession(source, "demo", startGraph);
	};

	const startLive = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		const startGraph = resetSessionState("live");

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
			signal: signalRef.current,
			onChunk: (chunk) => {
				console.log(
					`[meeting-live] chunk: "${chunk.text}" (${chunk.startMs}-${chunk.endMs}ms)`,
				);
				pushChunk(chunk);
			},
		});
		await runSession(source, "live", startGraph);
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
		setMode("idle");
		modeRef.current = "idle";
		setStatus("done");
	};

	const resetDemo = () => {
		signalRef.current.cancelled = true;
		signalRef.current.paused = false;
		runningRef.current = false;
		if (modeRef.current === "live") {
			invoke("stop_live_capture").catch(() => {});
		}
		setMode("idle");
		modeRef.current = "idle";
		const empty = emptyGraph();
		setGraph(empty);
		setBatchIdx(0);
		setHighlightIds(new Set());
		setError(null);
		setStats(INITIAL_STATS);
		transcriptRef.current = [];
		setTranscript([]);
		thoughtsRef.current = [];
		setPasses([]);
		consumedChunksRef.current = 0;
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
		startDemo,
		startLive,
		stopLive,
		pauseDemo,
		resumeDemo,
		resetDemo,
		generateNotes,
	};
}
