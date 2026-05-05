import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	ReactFlowProvider,
	type Edge as RFEdge,
	type Node as RFNode,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type PanelImperativeHandle,
	Group as ResizeGroup,
	Panel as ResizePanel,
	Separator as ResizeSeparator,
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
	// AIZ-12 — richer vocabulary, grouped by affinity
	risk: 3040,
	assumption: 3420,
	constraint: 3800,
	hypothesis: 4180,
	metric: 4560,
	artifact: 4940,
	event: 5320,
	sentiment: 5700,
};

const ROW_HEIGHT = 160;
// Approximate width of a rendered AizuchiNode card (matches `w-sm` in
// ai-elements/node.tsx). Used by the position-aware handle picker so an
// edge from column N to column N+1 chooses left/right handles, not
// a diagonal across the gap.
const NODE_WIDTH = 384;
const NODE_HEIGHT = 120;

type HandleSide = "left" | "right" | "top" | "bottom";

/**
 * AIZ-12 — pick which side of each node an edge should attach to so the
 * rendered path takes the shortest geometric route. We compare the
 * vector from source-center to target-center: whichever axis dominates
 * decides the side. This avoids the "weird path" failure mode where an
 * edge from a node on the right loops back around to the left handle.
 */
function pickHandles(
	from: { x: number; y: number },
	to: { x: number; y: number },
): { sourceHandle: string; targetHandle: string } {
	const fromCenter = {
		x: from.x + NODE_WIDTH / 2,
		y: from.y + NODE_HEIGHT / 2,
	};
	const toCenter = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT / 2 };
	const dx = toCenter.x - fromCenter.x;
	const dy = toCenter.y - fromCenter.y;

	let sourceSide: HandleSide;
	let targetSide: HandleSide;
	if (Math.abs(dx) >= Math.abs(dy)) {
		sourceSide = dx >= 0 ? "right" : "left";
		targetSide = dx >= 0 ? "left" : "right";
	} else {
		sourceSide = dy >= 0 ? "bottom" : "top";
		targetSide = dy >= 0 ? "top" : "bottom";
	}
	return { sourceHandle: `s-${sourceSide}`, targetHandle: `t-${targetSide}` };
}

// Drag the outline below this percentage and it snaps closed on release.
const OUTLINE_COLLAPSE_THRESHOLD = 20;

interface Neighborhood {
	nodeIds: ReadonlySet<string>;
	edgeIds: ReadonlySet<string>;
}

function computeNeighborhood(
	graph: Graph,
	selectedId: string | null,
): Neighborhood | null {
	if (!selectedId) return null;
	const nodeIds = new Set<string>([selectedId]);
	const edgeIds = new Set<string>();
	for (const e of graph.edges) {
		if (e.from === selectedId) {
			nodeIds.add(e.to);
			edgeIds.add(e.id);
		} else if (e.to === selectedId) {
			nodeIds.add(e.from);
			edgeIds.add(e.id);
		}
	}
	return { nodeIds, edgeIds };
}

function layoutGraph(
	graph: Graph,
	highlightIds: ReadonlySet<string>,
	selectedId: string | null,
): { nodes: RFNode[]; edges: RFEdge[] } {
	const neighborhood = computeNeighborhood(graph, selectedId);
	const counters: Partial<Record<NodeType, number>> = {};
	const positions = new Map<string, { x: number; y: number }>();
	const nodes: RFNode[] = graph.nodes.map((n) => {
		const idx = counters[n.type] ?? 0;
		counters[n.type] = idx + 1;
		const position = { x: COLUMN_X[n.type], y: idx * ROW_HEIGHT };
		positions.set(n.id, position);
		const inNeighborhood = neighborhood?.nodeIds.has(n.id) ?? false;
		const isFocused = neighborhood ? n.id === selectedId : false;
		const dimmed = !!neighborhood && !inNeighborhood;
		return {
			id: n.id,
			type: "aizuchi",
			position,
			data: {
				node: n,
				highlighted: highlightIds.has(n.id),
				inNeighborhood,
				isFocused,
				dimmed,
			},
		};
	});

	const edges: RFEdge[] = graph.edges.map((e) => {
		const fromPos = positions.get(e.from);
		const toPos = positions.get(e.to);
		const handles =
			fromPos && toPos
				? pickHandles(fromPos, toPos)
				: { sourceHandle: "s-right", targetHandle: "t-left" };
		const inNeighborhood = neighborhood?.edgeIds.has(e.id) ?? false;
		const dimmed = !!neighborhood && !inNeighborhood;
		return {
			id: e.id,
			source: e.from,
			target: e.to,
			sourceHandle: handles.sourceHandle,
			targetHandle: handles.targetHandle,
			type: "animated",
			label: e.relation,
			data: e,
			style: dimmed
				? { stroke: "var(--muted-foreground)", strokeOpacity: 0.15 }
				: inNeighborhood
					? { stroke: "var(--primary)", strokeWidth: 2 }
					: undefined,
		};
	});

	return { nodes, edges };
}

const nodeTypes = { aizuchi: AizuchiNode } as const;
const edgeTypes = {
	animated: AIEdge.Animated,
	temporary: AIEdge.Temporary,
} as const;

/**
 * AIZ-12 — when the AI touches new nodes (the highlightIds set turns
 * over), smoothly pan/zoom the viewport to frame those nodes so the
 * user sees the AI working live. We debounce slightly so a flurry of
 * adds inside a single pass produces one camera move, not several.
 */
function CameraFollower({
	highlightIds,
	graphNodeCount,
}: {
	highlightIds: ReadonlySet<string>;
	graphNodeCount: number;
}) {
	const { fitView } = useReactFlow();
	const previousIdsRef = useRef<ReadonlySet<string>>(new Set());

	useEffect(() => {
		const previous = previousIdsRef.current;
		const newlyTouched: string[] = [];
		for (const id of highlightIds) {
			if (!previous.has(id)) newlyTouched.push(id);
		}
		previousIdsRef.current = highlightIds;
		if (newlyTouched.length === 0) return;

		// Debounce so several add_nodes in one pass don't trigger several
		// successive camera moves — ReactFlow's fitView animates over time.
		const handle = window.setTimeout(() => {
			fitView({
				nodes: newlyTouched.map((id) => ({ id })),
				duration: 700,
				padding: 0.4,
				maxZoom: 1.2,
			});
		}, 80);
		return () => window.clearTimeout(handle);
	}, [highlightIds, fitView]);

	// First-paint: frame the whole graph once we have nodes. Without
	// this the canvas opens at the default zoom and the user sees a
	// distant cluster, not the work in progress.
	const firstFitDoneRef = useRef(false);
	useEffect(() => {
		if (firstFitDoneRef.current) return;
		if (graphNodeCount === 0) return;
		firstFitDoneRef.current = true;
		fitView({ duration: 400, padding: 0.3 });
	}, [graphNodeCount, fitView]);

	return null;
}

function MeetingPrototype() {
	useCommandPaletteHotkey();
	const { id } = Route.useParams();
	const session = useMeetingSession(id);

	const outlinePanelRef = useRef<PanelImperativeHandle>(null);
	const groupWrapperRef = useRef<HTMLDivElement>(null);
	const handleRef = useRef<HTMLDivElement>(null);
	const isDraggingRef = useRef(false);

	const isInHandle = (x: number, y: number) => {
		const r = handleRef.current?.getBoundingClientRect();
		if (!r) return false;
		return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
	};

	const handleOutlineResize = (size: { asPercentage: number }) => {
		if (!isDraggingRef.current) return;
		const wrapper = groupWrapperRef.current;
		if (!wrapper) return;
		const willClose =
			size.asPercentage > 0 && size.asPercentage < OUTLINE_COLLAPSE_THRESHOLD;
		wrapper.classList.toggle("aiz-will-close", willClose);
	};

	// isInHandle reads only from refs; rebinding the listener on every
	// render would churn document-level handlers without changing behavior.
	// biome-ignore lint/correctness/useExhaustiveDependencies: stable refs only
	useEffect(() => {
		// Window-level capture fires before the lib's document-level
		// capture handler and before the browser's default selection
		// logic. Engaging drag-state here (instead of in bubble phase)
		// means user-select:none is in place before React Flow's
		// box-select or text selection can paint a frame.
		const onWindowDownCapture = (e: PointerEvent) => {
			const wrapper = groupWrapperRef.current;
			if (!wrapper) return;
			const target = e.target as Element | null;
			if (!target || !wrapper.contains(target)) return;

			if (isInHandle(e.clientX, e.clientY)) {
				isDraggingRef.current = true;
				wrapper.classList.add("aiz-resizing");
				document.body.style.userSelect = "none";
				window.getSelection()?.removeAllRanges();
				// `inert` fully disables interaction inside the panels —
				// stronger than pointer-events:none, so React Flow's hover /
				// node-render work doesn't fire during the drag.
				for (const el of wrapper.querySelectorAll("[data-panel]")) {
					el.setAttribute("inert", "");
				}
				return;
			}

			const sep = wrapper.querySelector(
				"[data-separator]",
			) as HTMLElement | null;
			if (!sep) return;
			const sr = sep.getBoundingClientRect();
			// Match resizeTargetMinimumSize.fine (24px) — 12px each side.
			const inHitZone =
				e.clientX >= sr.left - 12 &&
				e.clientX <= sr.right + 12 &&
				e.clientY >= sr.top &&
				e.clientY <= sr.bottom;
			if (inHitZone) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		window.addEventListener("pointerdown", onWindowDownCapture, true);

		const onSelectStart = (e: Event) => {
			if (isDraggingRef.current) e.preventDefault();
		};
		document.addEventListener("selectstart", onSelectStart);
		const onUp = () => {
			if (!isDraggingRef.current) return;
			isDraggingRef.current = false;
			document.body.style.userSelect = "";
			const wrapper = groupWrapperRef.current;
			wrapper?.classList.remove("aiz-resizing", "aiz-will-close");
			if (wrapper) {
				for (const el of wrapper.querySelectorAll("[data-panel]")) {
					el.removeAttribute("inert");
				}
			}
			const size = outlinePanelRef.current?.getSize();
			if (
				!size ||
				size.asPercentage === 0 ||
				size.asPercentage >= OUTLINE_COLLAPSE_THRESHOLD
			) {
				return;
			}
			if (!wrapper) return;
			wrapper.classList.add("aiz-snapping");
			void wrapper.offsetWidth;
			outlinePanelRef.current?.collapse();
			window.setTimeout(() => {
				wrapper.classList.remove("aiz-snapping");
			}, 400);
		};
		document.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointerdown", onWindowDownCapture, true);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("selectstart", onSelectStart);
		};
	}, []);

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

	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Drop the focused selection if its node disappears (merge / remove).
	useEffect(() => {
		if (!selectedId) return;
		if (!session.graph.nodes.some((n) => n.id === selectedId)) {
			setSelectedId(null);
		}
	}, [session.graph, selectedId]);

	const { nodes, edges } = useMemo(
		() => layoutGraph(session.graph, session.highlightIds, selectedId),
		[session.graph, session.highlightIds, selectedId],
	);

	const onNodeClick = useCallback((_e: React.MouseEvent, node: RFNode) => {
		setSelectedId((current) => (current === node.id ? null : node.id));
	}, []);
	const onPaneClick = useCallback(() => setSelectedId(null), []);

	return (
		<div
			ref={groupWrapperRef}
			className="aiz-meeting-group h-screen w-screen bg-background"
		>
			<ResizeGroup
				orientation="horizontal"
				resizeTargetMinimumSize={{ fine: 24, coarse: 32 }}
				disableCursor
			>
				<ResizePanel defaultSize={72} minSize={40}>
					<div className="relative h-full w-full">
						<div className="aiz-canvas-shield pointer-events-none absolute inset-0 z-[2000] hidden" />
						<ReactFlowProvider>
							<Canvas
								nodes={nodes}
								edges={edges}
								nodeTypes={nodeTypes}
								edgeTypes={edgeTypes}
								onNodeClick={onNodeClick}
								onPaneClick={onPaneClick}
							>
								<CameraFollower
									highlightIds={session.highlightIds}
									graphNodeCount={session.graph.nodes.length}
								/>
								<Panel position="top-left">
									<MeetingStatusPanel
										status={session.status}
										mode={session.mode}
										batchIdx={session.batchIdx}
										chunkCount={session.transcript.length}
										graph={session.graph}
										error={session.error}
										stats={session.stats}
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
				</ResizePanel>
				<ResizeSeparator className="group relative w-px bg-transparent">
					<div
						ref={handleRef}
						className="absolute top-1/2 right-1.5 z-50 h-1/2 w-1.5 -translate-y-1/2 cursor-col-resize rounded-full bg-foreground/8 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-150 group-hover:bg-foreground/30 group-hover:shadow-[0_2px_6px_rgba(0,0,0,0.12)]"
					/>
				</ResizeSeparator>
				<ResizePanel
					id="aiz-outline-panel"
					panelRef={outlinePanelRef}
					defaultSize={28}
					minSize={1}
					collapsible
					collapsedSize={0}
					onResize={handleOutlineResize}
				>
					<MeetingOutline
						graph={session.graph}
						status={session.status}
						generatingNotes={session.generatingNotes}
						onGenerateNotes={session.generateNotes}
					/>
				</ResizePanel>
			</ResizeGroup>
		</div>
	);
}

export const Route = createFileRoute("/meeting/$id")({
	component: MeetingPrototype,
});

export type { AzEdge, AzNode };
