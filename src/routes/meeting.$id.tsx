import { createFileRoute, notFound } from "@tanstack/react-router";
import {
	ReactFlowProvider,
	type Edge as RFEdge,
	type Node as RFNode,
} from "@xyflow/react";
import { useMemo } from "react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Edge as AIEdge } from "@/components/ai-elements/edge";
import { Panel } from "@/components/ai-elements/panel";
import { AizuchiNode } from "@/components/aizuchi/aizuchi-node";
import { LiveTranscript } from "@/components/aizuchi/LiveTranscript";
import { MeetingStatusPanel } from "@/components/aizuchi/MeetingStatusPanel";
import { useCommandPaletteHotkey } from "@/hooks/useCommandPaletteHotkey";
import { useMeetingSession } from "@/hooks/useMeetingSession";
import type {
	Edge as AzEdge,
	Node as AzNode,
	Graph,
	NodeType,
} from "@/lib/aizuchi/schemas";

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
const edgeTypes = {
	animated: AIEdge.Animated,
	temporary: AIEdge.Temporary,
} as const;

function MeetingPrototype() {
	useCommandPaletteHotkey();
	const { id } = Route.useParams();
	const session = useMeetingSession(id);

	const { nodes, edges } = useMemo(
		() => layoutGraph(session.graph, session.highlightIds),
		[session.graph, session.highlightIds],
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
						<MeetingStatusPanel
							status={session.status}
							mode={session.mode}
							batchIdx={session.batchIdx}
							chunkCount={session.transcript.length}
							graph={session.graph}
							error={session.error}
							stats={session.stats}
							generatingNotes={session.generatingNotes}
							archivedAt={session.archivedAt}
							onStartDemo={session.startDemo}
							onStartLive={session.startLive}
							onResumeLive={session.resumeLive}
							onStopLive={session.stopLive}
							onPause={session.pauseDemo}
							onResume={session.resumeDemo}
							onReset={session.resetDemo}
							onGenerateNotes={session.generateNotes}
						/>
					</Panel>
					{session.transcript.length > 0 && (
						<Panel position="bottom-center">
							<LiveTranscript
								chunks={session.transcript}
								passes={session.passes}
								open={session.transcriptOpen}
								onToggle={() => session.setTranscriptOpen((v) => !v)}
							/>
						</Panel>
					)}
				</Canvas>
			</ReactFlowProvider>
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
