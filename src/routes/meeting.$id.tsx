import { createFileRoute, notFound } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	type Edge as RFEdge,
	type Node as RFNode,
	ReactFlowProvider,
} from "@xyflow/react";
import { ChevronUpIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Edge as AIEdge } from "@/components/ai-elements/edge";
import { Panel } from "@/components/ai-elements/panel";
import { useCommandPaletteHotkey } from "@/hooks/useCommandPaletteHotkey";
import { formatChunkBatch } from "@/lib/aizuchi/batcher";
import {
	type FeederSignal,
	consumeLiveStream,
	feedTranscriptBatches,
} from "@/lib/aizuchi/feeder";
import { standupTranscript } from "@/lib/aizuchi/fixtures/standup-transcript";
import { mutateGraph } from "@/lib/aizuchi/graph-mutation";
import {
	type AIThoughtRecord,
	applyDiff,
	emptyGraph,
	type Edge as AzEdge,
	type Graph,
	mergeThoughts,
	type Node as AzNode,
	type NodeType,
	type PassRecord,
	type TranscriptChunk,
} from "@/lib/aizuchi/schemas";
import { AizuchiNode } from "@/components/aizuchi/aizuchi-node";

const SIZE_THRESHOLD_WORDS = 60;
const TIME_THRESHOLD_MS = 25_000;
// Live mode: any of three thresholds triggers a batch — first one wins.
// The chunk-count cap protects against sparse / quiet speech where the
// first two never fire. Tuned for snappy feedback over batch density.
const LIVE_SIZE_THRESHOLD_WORDS = 18;
const LIVE_TIME_THRESHOLD_MS = 7_000;
const LIVE_CHUNK_COUNT_THRESHOLD = 3;
const HIGHLIGHT_MS = 1500;
const SPEED_MULTIPLIER = 4;
/** Sliding-window of transcript fed to the model for coreference / context. */
const RECENT_TRANSCRIPT_WINDOW_MS = 60_000;

const COLUMN_X: Record<NodeType, number> = {
	person: 0,
	topic: 380,
	work_item: 760,
	action_item: 1140,
	decision: 1520,
	blocker: 1900,
	question: 2280,
	context: 2660,
};

const ROW_HEIGHT = 160;

function layoutGraph(
	graph: Graph,
	highlightIds: ReadonlySet<string>,
): { nodes: RFNode[]; edges: RFEdge[] } {
	const counters: Partial<Record<NodeType, number>> = {};
	const nodes: RFNode[] = graph.nodes.map((n) => {
		const idx = counters[n.type] ?? 0;
		counters[n.type] = idx + 1;
		return {
			id: n.id,
			type: "aizuchi",
			position: { x: COLUMN_X[n.type], y: idx * ROW_HEIGHT },
			data: { node: n, highlighted: highlightIds.has(n.id) },
		};
	});

	const edges: RFEdge[] = graph.edges.map((e) => ({
		id: e.id,
		source: e.from,
		target: e.to,
		type: "animated",
		label: e.relation,
		data: e,
	}));

	return { nodes, edges };
}

const nodeTypes = { aizuchi: AizuchiNode } as const;
const edgeTypes = { animated: AIEdge.Animated, temporary: AIEdge.Temporary } as const;

type Status =
	| "idle"
	| "listening"
	| "thinking"
	| "updated"
	| "paused"
	| "done"
	| "error";

type Mode = "idle" | "demo" | "live";

interface RunStats {
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

function MeetingPrototype() {
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
	const consumedChunksRef = useRef(0);
	const thoughtsRef = useRef<AIThoughtRecord[]>([]);
	const transcriptRef = useRef<TranscriptChunk[]>([]);
	const [mode, setMode] = useState<Mode>("idle");
	const signalRef = useRef<FeederSignal>({ cancelled: false, paused: false });
	const runningRef = useRef(false);

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

	const applyThoughts = (incoming: import("@/lib/aizuchi/schemas").AIThought[]) => {
		const merged = mergeThoughts(thoughtsRef.current, incoming, Date.now());
		thoughtsRef.current = merged;
	};

	const recordPass = (
		batchIdx: number,
		consumedChunks: number,
		thoughts: import("@/lib/aizuchi/schemas").AIThought[],
	) => {
		const atChunkIdx = Math.max(consumedChunks - 1, 0);
		setPasses((p) => [
			...p,
			{
				id: `pass-${batchIdx}-${Date.now()}`,
				batchIdx,
				atChunkIdx,
				thoughts,
				timestamp: Date.now(),
			},
		]);
	};

	useCommandPaletteHotkey();

	const emitGraph = (g: Graph) => {
		getCurrentWindow()
			.emitTo("meeting-outline-test", "graph-update", g)
			.catch(() => {});
	};

	const startDemo = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		setMode("demo");
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

		let current: Graph = startGraph;
		let idx = 0;
		const signal = signalRef.current;
		try {
			for await (const batch of feedTranscriptBatches(standupTranscript, {
				sizeThresholdWords: SIZE_THRESHOLD_WORDS,
				timeThresholdMs: TIME_THRESHOLD_MS,
				speedMultiplier: SPEED_MULTIPLIER,
				signal,
				onChunk: pushChunk,
			})) {
				if (signal.cancelled) return;

				idx++;
				setBatchIdx(idx);
				setStatus("thinking");

				const result = await mutateGraph(current, formatChunkBatch(batch), {
					previousThoughts: thoughtsRef.current,
					recentTranscript: recentTranscriptText(),
				});
				if (signal.cancelled) return;

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
					totalInputTokens: s.totalInputTokens + (result.usage?.inputTokens ?? 0),
					totalOutputTokens:
						s.totalOutputTokens + (result.usage?.outputTokens ?? 0),
					providerLabel: result.providerLabel,
				}));

				await new Promise((r) => setTimeout(r, HIGHLIGHT_MS));
				if (signal.cancelled) return;
				setHighlightIds(new Set());
			}
			if (!signal.cancelled) setStatus("done");
		} catch (err) {
			if (signal.cancelled) return;
			console.error("Aizuchi batch failed", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		} finally {
			runningRef.current = false;
		}
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

	const resetDemo = () => {
		signalRef.current.cancelled = true;
		signalRef.current.paused = false;
		runningRef.current = false;
		if (mode === "live") {
			invoke("stop_live_capture").catch(() => {});
		}
		setMode("idle");
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

	const startLive = async () => {
		if (runningRef.current) return;
		runningRef.current = true;
		setMode("live");
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

		try {
			await invoke("start_live_capture");
		} catch (err) {
			console.error("start_live_capture failed", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
			runningRef.current = false;
			setMode("idle");
			return;
		}

		let current: Graph = startGraph;
		let idx = 0;
		const signal = signalRef.current;
		try {
			console.log("[meeting-live] subscribing to transcript-chunk events…");
			for await (const batch of consumeLiveStream({
				sizeThresholdWords: LIVE_SIZE_THRESHOLD_WORDS,
				timeThresholdMs: LIVE_TIME_THRESHOLD_MS,
				chunkCountThreshold: LIVE_CHUNK_COUNT_THRESHOLD,
				signal,
				onChunk: (chunk) => {
					console.log(
						`[meeting-live] chunk: "${chunk.text}" (${chunk.startMs}-${chunk.endMs}ms)`,
					);
					pushChunk(chunk);
				},
			})) {
				console.log(
					`[meeting-live] batch ${idx + 1}: ${batch.chunks.length} chunks, ${batch.wordCount} words`,
				);
				if (signal.cancelled) return;

				idx++;
				setBatchIdx(idx);
				setStatus("thinking");

				const result = await mutateGraph(current, formatChunkBatch(batch), {
					previousThoughts: thoughtsRef.current,
					recentTranscript: recentTranscriptText(),
				});
				if (signal.cancelled) return;
				console.log(
					`[meeting-live] mutate ${idx}: no_changes=${result.diff.no_changes} +nodes=${result.diff.add_nodes.length} +edges=${result.diff.add_edges.length} ~nodes=${result.diff.update_nodes.length} merges=${result.diff.merge_nodes.length} -nodes=${result.diff.remove_nodes.length} -edges=${result.diff.remove_edges.length} thoughts=${result.diff.notes.length} (${Math.round(result.latencyMs)}ms ${result.providerLabel})`,
				);

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
					totalInputTokens: s.totalInputTokens + (result.usage?.inputTokens ?? 0),
					totalOutputTokens:
						s.totalOutputTokens + (result.usage?.outputTokens ?? 0),
					providerLabel: result.providerLabel,
				}));

				await new Promise((r) => setTimeout(r, HIGHLIGHT_MS));
				if (signal.cancelled) return;
				setHighlightIds(new Set());
			}
		} catch (err) {
			if (signal.cancelled) return;
			console.error("Aizuchi live batch failed", err);
			setError(err instanceof Error ? err.message : String(err));
			setStatus("error");
		} finally {
			runningRef.current = false;
		}
	};

	const stopLive = async () => {
		signalRef.current.cancelled = true;
		runningRef.current = false;
		await invoke("stop_live_capture").catch(() => {});
		setMode("idle");
		setStatus("done");
	};

	useEffect(() => {
		return () => {
			signalRef.current.cancelled = true;
		};
	}, []);

	const { nodes, edges } = useMemo(
		() => layoutGraph(graph, highlightIds),
		[graph, highlightIds],
	);

	return (
		<div className="h-screen w-screen bg-background">
			<ReactFlowProvider>
				<Canvas
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
				>
					<Panel position="top-left">
						<StatusPanel
							status={status}
							mode={mode}
							batchIdx={batchIdx}
							chunkCount={transcript.length}
							graph={graph}
							error={error}
							stats={stats}
							onStartDemo={startDemo}
							onStartLive={startLive}
							onStopLive={stopLive}
							onPause={pauseDemo}
							onResume={resumeDemo}
							onReset={resetDemo}
						/>
					</Panel>
					{transcript.length > 0 && (
						<Panel position="bottom-center">
							<LiveTranscript
								chunks={transcript}
								passes={passes}
								open={transcriptOpen}
								onToggle={() => setTranscriptOpen((v) => !v)}
							/>
						</Panel>
					)}
				</Canvas>
			</ReactFlowProvider>
		</div>
	);
}

function StatusPanel({
	status,
	mode,
	batchIdx,
	chunkCount,
	graph,
	error,
	stats,
	onStartDemo,
	onStartLive,
	onStopLive,
	onPause,
	onResume,
	onReset,
}: {
	status: Status;
	mode: Mode;
	batchIdx: number;
	chunkCount: number;
	graph: Graph;
	error: string | null;
	stats: RunStats;
	onStartDemo: () => void;
	onStartLive: () => void;
	onStopLive: () => void;
	onPause: () => void;
	onResume: () => void;
	onReset: () => void;
}) {
	const dot =
		status === "listening"
			? "bg-amber-500 animate-pulse"
			: status === "thinking"
				? "bg-violet-500 animate-pulse"
				: status === "updated"
					? "bg-emerald-500"
					: status === "paused"
						? "bg-zinc-400"
						: status === "done"
							? "bg-sky-500"
							: status === "error"
								? "bg-red-500"
								: "bg-muted-foreground";

	const label =
		status === "listening"
			? "listening…"
			: status === "thinking"
				? "thinking…"
				: status === "updated"
					? "map updated"
					: status === "paused"
						? "paused"
						: status === "done"
							? "transcript complete"
							: status === "error"
								? "error"
								: "idle";

	const isRunning =
		status === "listening" ||
		status === "thinking" ||
		status === "updated";
	const canStart = status === "idle" || status === "done" || status === "error";
	const isLive = mode === "live";
	const isDemo = mode === "demo";

	return (
		<div className="flex min-w-[280px] flex-col gap-2 px-3 py-2 text-xs">
			<div className="flex items-center gap-2">
				<span className={`size-2 rounded-full ${dot}`} />
				<span className="font-medium">{label}</span>
				{mode !== "idle" && (
					<span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						{mode}
					</span>
				)}
				<span className="ml-auto text-muted-foreground">
					batch {batchIdx}
				</span>
			</div>
			<div className="text-muted-foreground">
				{graph.nodes.length} nodes · {graph.edges.length} edges
				{mode === "live" && (
					<>
						{" · "}
						<span className={chunkCount === 0 ? "text-amber-500" : ""}>
							{chunkCount} chunk{chunkCount === 1 ? "" : "s"}
						</span>
					</>
				)}
			</div>

			<div className="flex flex-wrap gap-1.5 pt-1">
				{canStart && (
					<>
						<button
							type="button"
							onClick={onStartLive}
							className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
						>
							● Start live audio
						</button>
						<button
							type="button"
							onClick={onStartDemo}
							className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
						>
							{status === "idle" ? "Run demo transcript" : "Replay demo"}
						</button>
					</>
				)}
				{isRunning && isDemo && (
					<button
						type="button"
						onClick={onPause}
						className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-500"
					>
						Pause
					</button>
				)}
				{isRunning && isLive && (
					<button
						type="button"
						onClick={onStopLive}
						className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
					>
						Stop
					</button>
				)}
				{status === "paused" && (
					<button
						type="button"
						onClick={onResume}
						className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
					>
						Resume
					</button>
				)}
				{(isRunning || status === "paused" || status === "done") && (
					<button
						type="button"
						onClick={onReset}
						className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
					>
						Reset
					</button>
				)}
			</div>

			{status === "idle" && (
				<div className="rounded border border-border/40 bg-muted/30 p-2 text-[11px] text-muted-foreground">
					<strong className="text-foreground">Live audio</strong>: streams
					mic into whisper, populates the map every ~2s.{" "}
					<strong className="text-foreground">Demo</strong>: replays the
					canned standup at {SPEED_MULTIPLIER}× speed.
				</div>
			)}
			{stats.providerLabel && (
				<div className="text-muted-foreground">
					{stats.providerLabel} · {(stats.totalLatencyMs / 1000).toFixed(1)}s
					{stats.totalInputTokens
						? ` · ${stats.totalInputTokens}↓ ${stats.totalOutputTokens}↑ tok`
						: ""}
				</div>
			)}
			{error && (
				<div className="mt-1 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-700">
					{error}
					{error.toLowerCase().includes("fetch") && (
						<div className="mt-1 text-[10px] text-red-700/80">
							Ollama may need <code>OLLAMA_ORIGINS=*</code> to accept
							cross-origin requests. Restart with{" "}
							<code>OLLAMA_ORIGINS=* ollama serve</code>.
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function LiveTranscript({
	chunks,
	passes,
	open,
	onToggle,
}: {
	chunks: TranscriptChunk[];
	passes: PassRecord[];
	open: boolean;
	onToggle: () => void;
}) {
	const last = chunks[chunks.length - 1];
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [chunks.length, passes.length, open]);

	if (!last) return null;

	// Group passes by the chunk index they fired after.
	const passesByChunk = new Map<number, PassRecord[]>();
	for (const pass of passes) {
		const list = passesByChunk.get(pass.atChunkIdx) ?? [];
		list.push(pass);
		passesByChunk.set(pass.atChunkIdx, list);
	}

	const totalThoughts = passes.reduce((sum, p) => sum + p.thoughts.length, 0);

	return (
		<motion.div
			layout
			className="w-[min(800px,80vw)] overflow-hidden rounded-md bg-background/85 shadow-md backdrop-blur"
		>
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						key="history"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
						className="overflow-hidden"
					>
						<div
							ref={scrollRef}
							className="max-h-[50vh] space-y-2 overflow-y-auto border-b border-border/40 px-4 py-3"
						>
							{chunks.map((chunk, i) => (
								<div key={`chunk-${chunk.startMs}-${i}`}>
									<div
										className={`text-sm leading-snug ${
											i === chunks.length - 1 ? "" : "text-muted-foreground"
										}`}
									>
										<span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
											{chunk.speaker}
										</span>
										<span>{chunk.text}</span>
									</div>
									{passesByChunk.get(i)?.map((pass) => (
										<PassMarker key={pass.id} pass={pass} />
									))}
								</div>
							))}
						</div>
					</motion.div>
				)}
			</AnimatePresence>

			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-muted/40"
			>
				<div className="flex-1 overflow-hidden">
					<span className="mr-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{last.speaker}
					</span>
					<span className="text-sm text-foreground">{last.text}</span>
				</div>
				<span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
					{chunks.length}c
					{totalThoughts > 0 && (
						<span className="ml-1 text-amber-500">· {totalThoughts}💡</span>
					)}
				</span>
				<ChevronUpIcon
					className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
						open ? "rotate-180" : ""
					}`}
				/>
			</button>
		</motion.div>
	);
}

const INTENT_BADGE_STYLE: Record<
	import("@/lib/aizuchi/schemas").ThoughtIntent,
	string
> = {
	unresolved: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
	question: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
	pattern:
		"bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40",
	observation:
		"bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/30",
	fyi: "bg-zinc-500/5 text-muted-foreground border-zinc-500/20",
};

function PassMarker({ pass }: { pass: PassRecord }) {
	if (pass.thoughts.length === 0) return null;
	return (
		<motion.div
			initial={{ opacity: 0, x: -8 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.2 }}
			className="my-1.5 ml-3 flex flex-col gap-1 border-l-2 border-amber-500/60 pl-3"
		>
			{pass.thoughts.map((t) => (
				<div
					key={t.id}
					className={`rounded-md border px-2 py-1 text-xs ${INTENT_BADGE_STYLE[t.intent]}`}
				>
					<span className="mr-2 text-[9px] font-semibold uppercase tracking-wider opacity-80">
						💡 {t.intent}
					</span>
					<span className="leading-snug">{t.text}</span>
				</div>
			))}
		</motion.div>
	);
}

export const Route = createFileRoute("/meeting/$id")({
	beforeLoad: () => {
		if (import.meta.env.VITE_AIZUCHI !== "1") throw notFound();
	},
	component: MeetingPrototype,
});

export type { AzEdge, AzNode };
