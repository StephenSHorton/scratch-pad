import { createFileRoute, notFound } from "@tanstack/react-router";
import {
	type Edge as RFEdge,
	type Node as RFNode,
	ReactFlowProvider,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Edge as AIEdge } from "@/components/ai-elements/edge";
import { Panel } from "@/components/ai-elements/panel";
import { useCommandPaletteHotkey } from "@/hooks/useCommandPaletteHotkey";
import { batchTranscript, formatChunkBatch } from "@/lib/aizuchi/batcher";
import { standupTranscript } from "@/lib/aizuchi/fixtures/standup-transcript";
import { mutateGraph } from "@/lib/aizuchi/graph-mutation";
import {
	applyDiff,
	emptyGraph,
	type Edge as AzEdge,
	type Graph,
	type Node as AzNode,
	type NodeType,
} from "@/lib/aizuchi/schemas";
import { AizuchiNode } from "@/components/aizuchi/aizuchi-node";

const SIZE_THRESHOLD_WORDS = 60;
const TIME_THRESHOLD_MS = 25_000;
const HIGHLIGHT_MS = 1500;

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

type Status = "idle" | "listening" | "updated" | "done" | "error";

interface RunStats {
	totalBatches: number;
	totalLatencyMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	providerLabel: string;
}

function MeetingPrototype() {
	const [graph, setGraph] = useState<Graph>(emptyGraph);
	const [status, setStatus] = useState<Status>("idle");
	const [batchIdx, setBatchIdx] = useState(0);
	const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [error, setError] = useState<string | null>(null);
	const [stats, setStats] = useState<RunStats>({
		totalBatches: 0,
		totalLatencyMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		providerLabel: "",
	});
	const cancelledRef = useRef(false);

	useCommandPaletteHotkey();

	useEffect(() => {
		cancelledRef.current = false;

		(async () => {
			let current: Graph = emptyGraph();
			let idx = 0;
			for (const batch of batchTranscript(
				standupTranscript,
				SIZE_THRESHOLD_WORDS,
				TIME_THRESHOLD_MS,
			)) {
				if (cancelledRef.current) return;
				idx++;
				setBatchIdx(idx);
				setStatus("listening");

				try {
					const result = await mutateGraph(current, formatChunkBatch(batch));
					if (cancelledRef.current) return;

					const next = applyDiff(current, result.diff);
					const changed = new Set<string>();
					for (const n of result.diff.add_nodes) changed.add(n.id);
					for (const u of result.diff.update_nodes) changed.add(u.id);

					current = next;
					setGraph(next);
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
					if (cancelledRef.current) return;
					setHighlightIds(new Set());
				} catch (err) {
					if (cancelledRef.current) return;
					console.error("Aizuchi batch failed", err);
					setError(err instanceof Error ? err.message : String(err));
					setStatus("error");
					return;
				}
			}
			if (!cancelledRef.current) setStatus("done");
		})();

		return () => {
			cancelledRef.current = true;
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
							batchIdx={batchIdx}
							graph={graph}
							error={error}
							stats={stats}
						/>
					</Panel>
				</Canvas>
			</ReactFlowProvider>
		</div>
	);
}

function StatusPanel({
	status,
	batchIdx,
	graph,
	error,
	stats,
}: {
	status: Status;
	batchIdx: number;
	graph: Graph;
	error: string | null;
	stats: RunStats;
}) {
	const dot =
		status === "listening"
			? "bg-amber-500 animate-pulse"
			: status === "updated"
				? "bg-emerald-500"
				: status === "done"
					? "bg-sky-500"
					: status === "error"
						? "bg-red-500"
						: "bg-muted-foreground";

	const label =
		status === "listening"
			? "listening…"
			: status === "updated"
				? "map updated"
				: status === "done"
					? "transcript complete"
					: status === "error"
						? "error"
						: "idle";

	return (
		<div className="flex min-w-[260px] flex-col gap-1 px-3 py-2 text-xs">
			<div className="flex items-center gap-2">
				<span className={`size-2 rounded-full ${dot}`} />
				<span className="font-medium">{label}</span>
				<span className="ml-auto text-muted-foreground">
					batch {batchIdx}
				</span>
			</div>
			<div className="text-muted-foreground">
				{graph.nodes.length} nodes · {graph.edges.length} edges
			</div>
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

export const Route = createFileRoute("/meeting/$id")({
	beforeLoad: () => {
		if (import.meta.env.VITE_AIZUCHI !== "1") throw notFound();
	},
	component: MeetingPrototype,
});

export type { AzEdge, AzNode };
