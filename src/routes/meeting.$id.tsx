import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	ReactFlowProvider,
	type Edge as RFEdge,
	type Node as RFNode,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import {
	Panel as ResizePanel,
	PanelGroup,
	PanelResizeHandle,
} from "react-resizable-panels";
import { Canvas } from "@/components/ai-elements/canvas";
import { Edge as AIEdge } from "@/components/ai-elements/edge";
import { Panel } from "@/components/ai-elements/panel";
import { AizuchiNode } from "@/components/aizuchi/aizuchi-node";
import { LiveTranscript } from "@/components/aizuchi/LiveTranscript";
import { MeetingOutline } from "@/components/aizuchi/MeetingOutline";
import { MeetingStatusPanel } from "@/components/aizuchi/MeetingStatusPanel";
import { useCommandPaletteHotkey } from "@/hooks/useCommandPaletteHotkey";
import { useMeetingSession } from "@/hooks/useMeetingSession";
import type { ExtractionMode, MeetingSource } from "@/lib/aizuchi/persistence";
import type {
	Edge as AzEdge,
	Node as AzNode,
	Graph,
	NodeType,
	TranscriptChunk,
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

	// AIZ-20 — IPC handshake for `meeting start` and `meeting stop`.
	// The CLI / MCP triggers a meeting via `POST /v1/meetings` which opens
	// this route with `?autostart=live` (or `=demo`); we kick off the
	// matching session method exactly once. The CLI / MCP triggers a stop
	// via `POST /v1/meetings/:id/stop`, which fires `cli:meeting-stop` —
	// we forward it to the session if the id matches.
	const autostartFiredRef = useRef(false);
	// autostart is a one-shot per route mount; depending on
	// session.{startLive,startDemo} would re-run when the hook returns new
	// closures and double-fire.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (autostartFiredRef.current) return;
		const params = new URLSearchParams(window.location.search);
		const autostart = params.get("autostart");
		if (autostart !== "live" && autostart !== "demo" && autostart !== "import")
			return;
		// Defer so the session hook has finished its initial setup. The
		// hook also guards against double-start via runningRef. Set the
		// fired-ref *inside* the timeout, not before — under React strict
		// mode the effect runs twice with a cleanup in between, and the
		// cleanup clears the pending timeout. If we set the ref up front,
		// the second run sees ref=true and bails, so startDemo never fires.
		const handle = setTimeout(() => {
			autostartFiredRef.current = true;
			if (autostart === "live") {
				session.startLive().catch((err) => {
					console.error("[meeting] autostart live failed", err);
				});
			} else if (autostart === "demo") {
				session.startDemo().catch((err) => {
					console.error("[meeting] autostart demo failed", err);
				});
			} else {
				// AIZ-30 — pop the chunks staged by the IPC import endpoint
				// and feed them to startImport. `take_pending_import` returns
				// `null` if the id has no entry (already consumed, or never
				// staged) — in that case there's nothing to do.
				invoke<{
					chunks: TranscriptChunk[];
					sourceFile: string;
					extractionMode: ExtractionMode;
					source: MeetingSource;
				} | null>("take_pending_import", { id })
					.then((pending) => {
						if (!pending) {
							console.warn(
								`[meeting] no pending import for ${id} — nothing to do`,
							);
							return;
						}
						return session.startImport(
							pending.chunks,
							pending.sourceFile,
							pending.extractionMode,
							pending.source,
						);
					})
					.catch((err) => {
						console.error("[meeting] autostart import failed", err);
					});
			}
		}, 100);
		return () => clearTimeout(handle);
	}, [id]);

	// re-subscribing on every session.stopLive identity change would tear
	// down the listener mid-stop; the closure already reads the current id.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		const unlistenPromise = listen<{ id: string }>(
			"cli:meeting-stop",
			(event) => {
				if (event.payload?.id !== id) return;
				session.stopLive().catch((err) => {
					console.error("[meeting] cli stop failed", err);
				});
			},
		);
		return () => {
			unlistenPromise.then((fn) => fn()).catch(() => {});
		};
	}, [id]);

	const { nodes, edges } = useMemo(
		() => layoutGraph(session.graph, session.highlightIds),
		[session.graph, session.highlightIds],
	);

	return (
		<div className="h-screen w-screen bg-background">
			<PanelGroup direction="horizontal">
				<ResizePanel defaultSize={72} minSize={40}>
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
									name={session.name}
									nameLockedByUser={session.nameLockedByUser}
									onSetName={session.setMeetingName}
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
				</ResizePanel>
				<PanelResizeHandle className="w-px bg-border transition-colors hover:w-0.5 hover:bg-foreground/20 data-[resize-handle-active]:bg-foreground/30" />
				<ResizePanel
					defaultSize={28}
					minSize={18}
					collapsible
					collapsedSize={0}
				>
					<MeetingOutline graph={session.graph} />
				</ResizePanel>
			</PanelGroup>
		</div>
	);
}

export const Route = createFileRoute("/meeting/$id")({
	component: MeetingPrototype,
});

export type { AzEdge, AzNode };
