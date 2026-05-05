import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import { quadtree as d3Quadtree } from "d3-quadtree";
import { type Selection, select } from "d3-selection";
import {
	type ZoomBehavior,
	type ZoomTransform,
	zoom,
	zoomIdentity,
} from "d3-zoom";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PositionMap } from "@/hooks/useForceLayout";
import type {
	Node as AzNode,
	EdgeRelation,
	Graph,
	NodeType,
	Severity,
} from "@/lib/aizuchi/schemas";

/**
 * AIZ-48 — custom canvas renderer for the meeting graph.
 *
 * v1 scope:
 *   - Single <canvas> with retina DPI scaling.
 *   - d3-zoom for pan-on-drag, scroll-pan, ctrl/cmd-scroll-zoom.
 *   - d3-quadtree hit testing → onNodeClick / onPaneClick parity.
 *   - Camera framing parity: first-paint snap, settled-keyed full-fit, and
 *     AI-touched-node follow with cubic-out animation.
 *   - Per-type drawings for the 5 priority types (person/decision/risk/
 *     metric/event); other 11 fall through to a generic colored pill.
 *   - Variable node height — labels wrap to a 4-line cap, pill grows to fit.
 *   - Relation-driven edge colors and dashed strokes for rejection-flavored
 *     relations.
 *   - 32px world-spaced dot grid behind everything for pan-affordance.
 *   - Dirty-flag rAF redraw: idle CPU = 0 once the simulation settles.
 */

// Pill width is fixed; height grows to fit wrapped label text. The minimum
// height (`CARD_H_MIN`) gives a single-line node the classic stadium shape.
const CARD_W = 280;
const CARD_H_MIN = 56;
const CARD_R_MAX = 28;

// Inner geometry for type decorations + breathing room between decorations
// and the wrapped text block. `DECORATION_GAP` is what stops the small
// dots, severity indicators, and date stamps from kissing the label.
const PILL_PAD_X = 16;
const DECORATION_GAP = 10;
const DOT_R = 5;
const DOT_CX_OFFSET = CARD_R_MAX - 4; // dot centered inside the curved cap
const SEV_DOT_R = 4.5;
const SEV_DOT_GAP = 5;

// Label typography. Used both at draw time and during layout-time wrapping
// (off the offscreen `measureCtx`).
const LABEL_FONT = "600 13px system-ui, sans-serif";
const LABEL_LINE_HEIGHT = 17;
const LABEL_VERTICAL_PADDING = 14;
const LABEL_MAX_LINES = 4;
const LABEL_MIN_WIDTH = 60;

// Description (secondary text) typography. Smaller, lighter, capped tighter —
// only renders when `n.description` is non-empty. Title is also capped tighter
// in that case so the two blocks together stay within a sensible budget.
const DESC_FONT = "400 11px system-ui, sans-serif";
const DESC_LINE_HEIGHT = 15;
const DESC_MAX_LINES = 3;
const TITLE_MAX_LINES_WITH_DESC = 2;
const TITLE_DESC_GAP = 4;

// 32px world-spaced dot grid behind everything else, drawn on the canvas in
// the same transform pass so it pans/zooms in lockstep with the content.
// Hides below ~8px screen spacing to avoid moiré at far zoom.
const DOT_WORLD_SPACING = 32;
const DOT_MIN_SCREEN_SPACING = 8;

// Type → accent color. Same Tailwind-500-shade palette the meeting outline
// and other type-aware UI use, so the user's mental color-code association
// stays consistent across the app.
const TYPE_COLOR: Record<NodeType, string> = {
	person: "rgb(99, 102, 241)", // indigo
	topic: "rgb(100, 116, 139)", // slate
	work_item: "rgb(6, 182, 212)", // cyan
	action_item: "rgb(16, 185, 129)", // emerald
	decision: "rgb(139, 92, 246)", // violet
	blocker: "rgb(239, 68, 68)", // red
	question: "rgb(245, 158, 11)", // amber
	context: "rgb(113, 113, 122)", // zinc
	risk: "rgb(244, 63, 94)", // rose
	assumption: "rgb(234, 179, 8)", // yellow
	constraint: "rgb(249, 115, 22)", // orange
	hypothesis: "rgb(14, 165, 233)", // sky
	metric: "rgb(20, 184, 166)", // teal
	artifact: "rgb(120, 113, 108)", // stone
	event: "rgb(217, 70, 239)", // fuchsia
	sentiment: "rgb(236, 72, 153)", // pink
};

// Risk node likelihood/impact severity dots — green/amber/red traffic-light.
const SEVERITY_COLOR: Record<Severity, string> = {
	low: "rgba(16, 185, 129, 0.9)", // emerald
	medium: "rgba(245, 158, 11, 0.95)", // amber
	high: "rgba(239, 68, 68, 0.95)", // red
};

interface EdgeStyle {
	color: string;
	/** Stroke width at default presence — modulated up for in-neighborhood. */
	width: number;
	/** Dashed stroke for relations that imply rejection / counter-flow. */
	dashed?: boolean;
}

// Relation → stroke style. Grouped by semantic family:
//   - causal: distinct hue, slightly heavier
//   - structural (ownership / dependency / decision flow): medium-weight
//   - reference (mention / clarification / Q&A): lighter
//   - hierarchical (example / alternative / precedence): medium-light
// Dashed strokes are reserved for rejection-flavored relations
// (`contradicts`, `alternative_to`).
const RELATION_STYLE: Record<EdgeRelation, EdgeStyle> = {
	causes: { color: "rgb(249, 115, 22)", width: 1.5 }, // orange
	resolves: { color: "rgb(16, 185, 129)", width: 1.5 }, // emerald
	blocks: { color: "rgb(239, 68, 68)", width: 1.5 }, // red
	contradicts: { color: "rgb(244, 63, 94)", width: 1.25, dashed: true }, // rose
	supports: { color: "rgb(20, 184, 166)", width: 1.25 }, // teal
	depends_on: { color: "rgb(6, 182, 212)", width: 1.25 }, // cyan
	owns: { color: "rgb(99, 102, 241)", width: 1.25 }, // indigo
	decides: { color: "rgb(139, 92, 246)", width: 1.25 }, // violet
	assigned_to: { color: "rgb(34, 197, 94)", width: 1 }, // green
	asks: { color: "rgb(245, 158, 11)", width: 1 }, // amber
	answers: { color: "rgb(16, 185, 129)", width: 1 }, // emerald
	clarifies: { color: "rgb(14, 165, 233)", width: 1 }, // sky
	related_to: { color: "rgb(120, 120, 130)", width: 0.9 }, // gray
	mentions: { color: "rgb(160, 160, 170)", width: 0.7 }, // gray-light
	example_of: { color: "rgb(120, 113, 108)", width: 0.9 }, // stone
	alternative_to: {
		color: "rgb(249, 115, 22)",
		width: 0.9,
		dashed: true,
	}, // orange-dashed
	precedes: { color: "rgb(100, 116, 139)", width: 1 }, // slate
};

// Module-level offscreen canvas for measureText calls during layout. Sharing
// one instance avoids the cost of creating one per layout pass — and lets us
// run layout outside of a draw frame (e.g. during render via useMemo).
const measureCanvas =
	typeof document !== "undefined" ? document.createElement("canvas") : null;
const measureCtx = measureCanvas?.getContext("2d") ?? null;

interface NodeLayout {
	w: number;
	h: number;
	labelLines: string[];
	/** Empty when `n.description` is absent — pill stays compact. */
	descLines: string[];
	leftPad: number;
	rightPad: number;
}

type LayoutMap = ReadonlyMap<string, NodeLayout>;

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

/** Flat array variant of `computeNeighborhood`'s `nodeIds`, for fitView. */
function neighborhoodIdsForFit(graph: Graph, focused: string): string[] {
	const n = computeNeighborhood(graph, focused);
	return n ? Array.from(n.nodeIds) : [focused];
}

interface MeetingCanvasProps {
	graph: Graph;
	positions: PositionMap;
	highlightIds: ReadonlySet<string>;
	selectedId: string | null;
	/**
	 * Timestamp of the most recent d3-force settle. Drives the camera-framing
	 * effect — we only animate when nodes have stopped moving.
	 */
	settledAt: number;
	onNodeClick?: (node: AzNode) => void;
	onPaneClick?: () => void;
	/** Overlay panels (status, transcript) rendered above the canvas. */
	children?: ReactNode;
}

interface DrawState {
	graph: Graph;
	positions: PositionMap;
	highlightIds: ReadonlySet<string>;
	selectedId: string | null;
	nodeLayouts: LayoutMap;
}

type CanvasSelection = Selection<HTMLCanvasElement, unknown, null, undefined>;
type CanvasZoom = ZoomBehavior<HTMLCanvasElement, unknown>;

export function MeetingCanvas({
	graph,
	positions,
	highlightIds,
	selectedId,
	settledAt,
	onNodeClick,
	onPaneClick,
	children,
}: MeetingCanvasProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const transformRef = useRef<ZoomTransform>(zoomIdentity.scale(0.4));
	const rafRef = useRef<number | null>(null);
	// True when the most recent gesture moved the transform — used to suppress
	// the synthetic click that fires after a pan-drag.
	const didDragRef = useRef(false);
	// d3-zoom plumbing kept in refs so camera helpers (called from effects) can
	// sync d3-zoom's internal transform after a programmatic move.
	const selectionRef = useRef<CanvasSelection | null>(null);
	const zoomBehaviorRef = useRef<CanvasZoom | null>(null);
	// Increments each time animateZoom is called; older animations bail when
	// they see the token has moved on.
	const animationTokenRef = useRef(0);
	// Camera-follow bookkeeping. AI-touched IDs queue here when highlightIds
	// changes; the settle effect below consumes the queue and fires fitView.
	const previousHighlightsRef = useRef<ReadonlySet<string>>(new Set());
	const pendingFitRef = useRef<string[] | null>(null);
	const firstFitDoneRef = useRef(false);
	// Focus-mode camera bookkeeping. When `selectedId` becomes non-null, the
	// settle effect frames the focused node + its neighborhood (the d3 sim is
	// also re-laying it out around world (0,0) — without this fit the user
	// would see the focus rearrangement happen off-screen).
	const previousSelectedRef = useRef<string | null>(null);
	const pendingFocusFitRef = useRef<string | null>(null);

	// Screen-reader announcement for newly-AI-touched nodes. The canvas itself
	// is opaque to assistive tech, so we mirror updates into an aria-live
	// region. Initial highlights aren't announced (would fire on every mount).
	const [liveMessage, setLiveMessage] = useState("");
	const previousHighlightsForAriaRef = useRef<ReadonlySet<string>>(new Set());
	const ariaInitializedRef = useRef(false);

	// Per-node layout (height, wrapped label lines, paddings) — recomputed
	// when the graph identity changes. d3-force never replaces the array, so
	// the AI graph mutator drives this; positions changing during a settle
	// don't trigger layout work.
	const nodeLayouts = useMemo<LayoutMap>(() => {
		const map = new Map<string, NodeLayout>();
		for (const n of graph.nodes) map.set(n.id, computeNodeLayout(n));
		return map;
	}, [graph]);

	// Latest props snapshot for the draw loop. Held in a ref so the d3-zoom
	// listener (bound once) always reads fresh data without re-binding.
	const drawStateRef = useRef<DrawState>({
		graph,
		positions,
		highlightIds,
		selectedId,
		nodeLayouts,
	});
	drawStateRef.current = {
		graph,
		positions,
		highlightIds,
		selectedId,
		nodeLayouts,
	};

	// scheduleDraw needs to be reachable from both the persistent zoom listener
	// (mount effect) and the props-change effect, so we keep it in a ref.
	const scheduleDrawRef = useRef<() => void>(() => {});

	useEffect(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!canvas || !container) return;

		const scheduleDraw = () => {
			if (rafRef.current !== null) return;
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = null;
				drawFrame(
					canvas,
					container,
					transformRef.current,
					drawStateRef.current,
				);
			});
		};
		scheduleDrawRef.current = scheduleDraw;

		// Track whether a gesture moved the transform. We compare start vs
		// end transforms so the click handler (which fires after pointerup,
		// after the "end" event) sees the right value. Reset on each "start".
		let gestureStart: ZoomTransform | null = null;

		const sel = select(canvas);
		const z = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.1, 4])
			.on("start", (e) => {
				gestureStart = e.transform;
			})
			.on("zoom", (e) => {
				transformRef.current = e.transform;
				scheduleDraw();
			})
			.on("end", (e) => {
				const s = gestureStart;
				didDragRef.current =
					!!s &&
					(e.transform.x !== s.x ||
						e.transform.y !== s.y ||
						e.transform.k !== s.k);
				gestureStart = null;
			});
		sel.call(z);
		selectionRef.current = sel;
		zoomBehaviorRef.current = z;

		// First-paint snap: center the canvas viewport on world (0,0) at 0.4×.
		// New nodes are seeded near (0,0) and take ~1.8s to spread out — without
		// this, the user stares at a clump of overlapping cards before the first
		// settle. The settledAt-keyed fitView below takes over once nodes are
		// actually placed.
		const cx = container.clientWidth / 2;
		const cy = container.clientHeight / 2;
		const initial = zoomIdentity.translate(cx, cy).scale(0.4);
		sel.call(z.transform, initial);
		didDragRef.current = false;

		const ro = new ResizeObserver(() => scheduleDraw());
		ro.observe(container);

		scheduleDraw();

		return () => {
			sel.on(".zoom", null);
			ro.disconnect();
			selectionRef.current = null;
			zoomBehaviorRef.current = null;
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, []);

	// Listed deps are triggers, not data — drawStateRef gets the fresh values
	// each render and scheduleDrawRef is stable. The effect's job is to fire
	// when any of these change, which is exactly the dependency array's intent.
	// biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not refs
	useEffect(() => {
		scheduleDrawRef.current();
	}, [graph, positions, highlightIds, selectedId, nodeLayouts]);

	// Track newly-touched highlightIds → queue them for the next settle. We
	// don't fire the camera move from here; the settledAt effect below does
	// it, so we never chase mid-flight positions during a force-restart.
	useEffect(() => {
		const previous = previousHighlightsRef.current;
		const newlyTouched: string[] = [];
		for (const id of highlightIds) {
			if (!previous.has(id)) newlyTouched.push(id);
		}
		previousHighlightsRef.current = highlightIds;
		if (newlyTouched.length > 0) {
			pendingFitRef.current = newlyTouched;
		}
	}, [highlightIds]);

	// Track focus enter: queue a camera fit for the next settle so the
	// rearranged neighborhood ends up centered on screen instead of at the
	// world origin off-camera. On unfocus we deliberately do NOT queue a
	// fit — the user is meant to see the elastic flick-back animate
	// through their current viewport.
	useEffect(() => {
		if (selectedId !== previousSelectedRef.current) {
			if (selectedId) pendingFocusFitRef.current = selectedId;
			previousSelectedRef.current = selectedId;
		}
	}, [selectedId]);

	// Announce newly-AI-touched nodes through the aria-live region. Skip the
	// very first render — initial highlights are state-on-load, not "updates".
	useEffect(() => {
		if (!ariaInitializedRef.current) {
			previousHighlightsForAriaRef.current = highlightIds;
			ariaInitializedRef.current = true;
			return;
		}
		const previous = previousHighlightsForAriaRef.current;
		const newlyTouched: AzNode[] = [];
		for (const id of highlightIds) {
			if (previous.has(id)) continue;
			const node = graph.nodes.find((n) => n.id === id);
			if (node) newlyTouched.push(node);
		}
		previousHighlightsForAriaRef.current = highlightIds;
		if (newlyTouched.length === 0) return;
		const summary = newlyTouched
			.map((n) => `${formatTypeForAria(n.type)}: ${n.label}`)
			.join("; ");
		setLiveMessage(`AI updated: ${summary}`);
	}, [highlightIds, graph]);

	// Camera moves on settle. Priority order:
	//   1. focus enter — user just clicked a node, frame its neighborhood
	//   2. AI-follow — gemma just touched nodes, frame those
	//   3. first-paint full-fit — frame the whole graph once, on first settle
	// User intent (1) outranks AI work (2) because the user clicked
	// deliberately; AI work outranks the overview because where gemma is
	// working matters more than a generic wide view.
	// `graph.nodes.length` listed only as a trigger; we read fresh state via
	// refs inside the effect.
	// biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not refs
	useEffect(() => {
		if (settledAt === 0) return;
		const state = drawStateRef.current;
		if (state.graph.nodes.length === 0) return;
		const container = containerRef.current;
		if (!container) return;

		const pendingFocus = pendingFocusFitRef.current;
		pendingFocusFitRef.current = null;
		if (pendingFocus) {
			firstFitDoneRef.current = true;
			const ids = neighborhoodIdsForFit(state.graph, pendingFocus);
			const target = computeFitTransform(
				state.positions,
				state.nodeLayouts,
				ids,
				container.clientWidth,
				container.clientHeight,
				0.4,
				1.1,
			);
			if (target) animateZoom(target, 700);
			return;
		}

		const pending = pendingFitRef.current;
		pendingFitRef.current = null;
		if (pending && pending.length > 0) {
			firstFitDoneRef.current = true;
			const target = computeFitTransform(
				state.positions,
				state.nodeLayouts,
				pending,
				container.clientWidth,
				container.clientHeight,
				0.6,
				0.8,
			);
			if (target) animateZoom(target, 700);
			return;
		}
		if (!firstFitDoneRef.current) {
			firstFitDoneRef.current = true;
			const allIds = state.graph.nodes.map((n) => n.id);
			const target = computeFitTransform(
				state.positions,
				state.nodeLayouts,
				allIds,
				container.clientWidth,
				container.clientHeight,
				0.3,
				0.8,
			);
			if (target) animateZoom(target, 600);
		}
	}, [settledAt, graph.nodes.length]);

	// Cubic-out interpolation between the current transform and a target. The
	// final frame syncs d3-zoom's internal state via sel.call(z.transform) so
	// the next user pan starts from the right place; we then clear didDragRef
	// so that one synthetic click isn't suppressed afterward.
	function animateZoom(target: ZoomTransform, duration: number) {
		const sel = selectionRef.current;
		const z = zoomBehaviorRef.current;
		if (!sel || !z) return;
		if (duration <= 0) {
			sel.call(z.transform, target);
			didDragRef.current = false;
			return;
		}
		const token = ++animationTokenRef.current;
		const from = transformRef.current;
		const startTime = performance.now();

		const step = (now: number) => {
			if (token !== animationTokenRef.current) return;
			const elapsed = now - startTime;
			const t = Math.min(1, elapsed / duration);
			const eased = 1 - (1 - t) ** 3;
			const x = from.x + (target.x - from.x) * eased;
			const y = from.y + (target.y - from.y) * eased;
			const k = from.k + (target.k - from.k) * eased;
			transformRef.current = zoomIdentity.translate(x, y).scale(k);
			scheduleDrawRef.current();
			if (t < 1) {
				requestAnimationFrame(step);
			} else {
				sel.call(z.transform, target);
				didDragRef.current = false;
			}
		};
		requestAnimationFrame(step);
	}

	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLCanvasElement>) => {
			// Suppress clicks that ended a pan/zoom gesture.
			if (didDragRef.current) {
				didDragRef.current = false;
				return;
			}
			const canvas = canvasRef.current;
			if (!canvas) return;
			const rect = canvas.getBoundingClientRect();
			const cssX = e.clientX - rect.left;
			const cssY = e.clientY - rect.top;
			const [worldX, worldY] = transformRef.current.invert([cssX, cssY]);
			const node = hitTestNode(drawStateRef.current, worldX, worldY);
			if (node) onNodeClick?.(node);
			else onPaneClick?.();
		},
		[onNodeClick, onPaneClick],
	);

	return (
		<div ref={containerRef} className="relative h-full w-full bg-sidebar">
			<canvas
				ref={canvasRef}
				className="absolute inset-0"
				onClick={handleClick}
			/>
			<section aria-label="Meeting graph" className="sr-only">
				<ul>
					{graph.nodes.map((n) => (
						<li key={n.id}>
							{formatTypeForAria(n.type)}: {n.label}
							{n.description ? `. ${n.description}` : ""}
						</li>
					))}
				</ul>
				<div aria-live="polite" aria-atomic="true">
					{liveMessage}
				</div>
			</section>
			{children}
		</div>
	);
}

function formatTypeForAria(type: NodeType): string {
	return type.replace(/_/g, " ");
}

// ─── layout ──────────────────────────────────────────────────────────────────

/**
 * Per-type left/right padding from the pill edge to where the wrapped label
 * may start/end. Read at layout time (driving label wrap width) and at draw
 * time (positioning the type-specific decorations consistent with the wrap).
 *
 * Every padding here is `decoration_extent + DECORATION_GAP`, where
 * `decoration_extent` is the right edge of a left decoration (or the left
 * edge of a right decoration). Keeping that one rule means new types or
 * tweaks to existing decorations can't accidentally squeeze the text.
 */
function paddingsFor(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
): { leftPad: number; rightPad: number } {
	const dotLeftEdge = DOT_CX_OFFSET + DOT_R; // x-relative right edge of left dot
	const sevDotsW = 2 * SEV_DOT_R * 2 + SEV_DOT_GAP; // both severity dots + gap

	switch (n.type) {
		case "person": {
			// Avatar at x+4, diameter 44 → right edge at x+48.
			return {
				leftPad: 4 + 44 + DECORATION_GAP,
				rightPad: PILL_PAD_X + measureTypeLabel(ctx, n) + DECORATION_GAP,
			};
		}
		case "decision": {
			ctx.font = "700 9px system-ui, sans-serif";
			const badgeW = ctx.measureText("DECIDED").width + 14;
			// Badge at x+10, right edge at x+10+badgeW.
			return {
				leftPad: 10 + badgeW + DECORATION_GAP,
				rightPad: PILL_PAD_X + measureTypeLabel(ctx, n) + DECORATION_GAP,
			};
		}
		case "risk": {
			return {
				leftPad: dotLeftEdge + DECORATION_GAP,
				rightPad: PILL_PAD_X + sevDotsW + DECORATION_GAP,
			};
		}
		case "metric": {
			if (n.value) {
				ctx.font = "700 17px system-ui, sans-serif";
				const valW = ctx.measureText(n.value).width;
				let rPad = PILL_PAD_X;
				if (n.target) {
					ctx.font = "500 11px system-ui, sans-serif";
					const tW = ctx.measureText(`/ ${n.target}`).width;
					rPad = PILL_PAD_X + tW + DECORATION_GAP;
				}
				return { leftPad: 18 + valW + DECORATION_GAP, rightPad: rPad };
			}
			return {
				leftPad: dotLeftEdge + DECORATION_GAP,
				rightPad: PILL_PAD_X + measureTypeLabel(ctx, n) + DECORATION_GAP,
			};
		}
		case "event": {
			let rPad = PILL_PAD_X;
			if (n.occurredAt) {
				ctx.font = "600 11px system-ui, sans-serif";
				const dateText = formatEventDate(n.occurredAt);
				rPad = PILL_PAD_X + ctx.measureText(dateText).width + DECORATION_GAP;
			}
			return {
				leftPad: dotLeftEdge + DECORATION_GAP,
				rightPad: rPad,
			};
		}
		default:
			return {
				leftPad: dotLeftEdge + DECORATION_GAP,
				rightPad: PILL_PAD_X + measureTypeLabel(ctx, n) + DECORATION_GAP,
			};
	}
}

function measureTypeLabel(ctx: CanvasRenderingContext2D, n: AzNode): number {
	ctx.font = "600 8px system-ui, sans-serif";
	return ctx.measureText(n.type.toUpperCase()).width;
}

function computeNodeLayout(n: AzNode): NodeLayout {
	if (!measureCtx) {
		return {
			w: CARD_W,
			h: CARD_H_MIN,
			labelLines: [n.label],
			descLines: [],
			leftPad: 18,
			rightPad: 18,
		};
	}
	const { leftPad, rightPad } = paddingsFor(measureCtx, n);
	const textMaxW = Math.max(LABEL_MIN_WIDTH, CARD_W - leftPad - rightPad);

	const description = n.description?.trim();

	// Pretext owns text measurement & wrapping. Multilingual (CJK / RTL /
	// emoji) and word-boundary segmentation come for free, versus the
	// hand-rolled wrap we had before. `layoutWithLines` doesn't truncate,
	// so we still cap and ellipsize the last visible line ourselves.
	const titleMaxLines = description
		? TITLE_MAX_LINES_WITH_DESC
		: LABEL_MAX_LINES;
	const labelLines = wrapAndCap(
		n.label,
		LABEL_FONT,
		textMaxW,
		LABEL_LINE_HEIGHT,
		titleMaxLines,
	);

	const descLines = description
		? wrapAndCap(
				description,
				DESC_FONT,
				textMaxW,
				DESC_LINE_HEIGHT,
				DESC_MAX_LINES,
			)
		: [];

	const labelH = labelLines.length * LABEL_LINE_HEIGHT;
	const descH =
		descLines.length > 0
			? TITLE_DESC_GAP + descLines.length * DESC_LINE_HEIGHT
			: 0;
	const naturalH = LABEL_VERTICAL_PADDING * 2 + labelH + descH;
	const h = Math.max(CARD_H_MIN, naturalH);
	return { w: CARD_W, h, labelLines, descLines, leftPad, rightPad };
}

function wrapAndCap(
	text: string,
	font: string,
	maxWidth: number,
	lineHeight: number,
	maxLines: number,
): string[] {
	const prepared = prepareWithSegments(text, font);
	const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
	let out = lines.map((l) => l.text);
	if (out.length > maxLines) {
		out = out.slice(0, maxLines);
		out[maxLines - 1] = ellipsizeTail(out[maxLines - 1], maxWidth, font);
	}
	return out;
}

/**
 * Trim a single line so that "<line>…" fits within maxWidth. Cheap because
 * it's only run on the last visible line when LABEL_MAX_LINES kicks in.
 */
function ellipsizeTail(line: string, maxWidth: number, font: string): string {
	if (!measureCtx) return `${line}…`;
	measureCtx.font = font;
	let truncated = line.replace(/\s+$/, "");
	while (
		truncated.length > 0 &&
		measureCtx.measureText(`${truncated}…`).width > maxWidth
	) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}…`;
}

// ─── hit testing ─────────────────────────────────────────────────────────────

interface HitEntry {
	id: string;
	cx: number;
	cy: number;
	w: number;
	h: number;
}

/**
 * Hit-test a click at world coords. Builds a quadtree on the fly (microseconds
 * at 200 nodes, simpler than maintaining a cache that re-keys every tick).
 * Validates the candidate is inside the node's actual rect — quadtree.find
 * returns the nearest center, not the hit rect. Each node may have a
 * different height after wrapping, so the rect check uses per-node bounds.
 */
function hitTestNode(
	state: DrawState,
	worldX: number,
	worldY: number,
): AzNode | null {
	const entries: HitEntry[] = [];
	let maxDiagonal = 0;
	for (const n of state.graph.nodes) {
		const p = state.positions.get(n.id);
		const layout = state.nodeLayouts.get(n.id);
		if (!p || !layout) continue;
		entries.push({
			id: n.id,
			cx: p.x + layout.w / 2,
			cy: p.y + layout.h / 2,
			w: layout.w,
			h: layout.h,
		});
		const d = Math.hypot(layout.w, layout.h);
		if (d > maxDiagonal) maxDiagonal = d;
	}
	if (entries.length === 0) return null;
	const qt = d3Quadtree<HitEntry>()
		.x((d) => d.cx)
		.y((d) => d.cy)
		.addAll(entries);
	const nearest = qt.find(worldX, worldY, maxDiagonal / 2);
	if (!nearest) return null;
	if (
		worldX < nearest.cx - nearest.w / 2 ||
		worldX > nearest.cx + nearest.w / 2 ||
		worldY < nearest.cy - nearest.h / 2 ||
		worldY > nearest.cy + nearest.h / 2
	) {
		return null;
	}
	return state.graph.nodes.find((n) => n.id === nearest.id) ?? null;
}

// ─── camera fitView ──────────────────────────────────────────────────────────

/**
 * Compute the d3-zoom transform that frames a set of node IDs in the viewport.
 * `padding: 0.3` reserves 30% of each viewport dimension as breathing room
 * (so the bbox occupies ~70%). Uses each node's actual rendered bounds, so
 * wrapped-tall nodes don't get clipped at the bbox top/bottom.
 */
function computeFitTransform(
	positions: PositionMap,
	layouts: LayoutMap,
	nodeIds: string[],
	viewportW: number,
	viewportH: number,
	padding: number,
	maxZoom: number,
): ZoomTransform | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const id of nodeIds) {
		const p = positions.get(id);
		if (!p) continue;
		const layout = layouts.get(id);
		const w = layout?.w ?? CARD_W;
		const h = layout?.h ?? CARD_H_MIN;
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x + w > maxX) maxX = p.x + w;
		if (p.y + h > maxY) maxY = p.y + h;
	}
	if (!Number.isFinite(minX)) return null;

	const bboxW = maxX - minX;
	const bboxH = maxY - minY;
	const usableW = viewportW * (1 - padding);
	const usableH = viewportH * (1 - padding);
	const k = Math.min(usableW / bboxW, usableH / bboxH, maxZoom);

	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const tx = viewportW / 2 - cx * k;
	const ty = viewportH / 2 - cy * k;
	return zoomIdentity.translate(tx, ty).scale(k);
}

// ─── drawing ─────────────────────────────────────────────────────────────────

function drawFrame(
	canvas: HTMLCanvasElement,
	container: HTMLElement,
	transform: ZoomTransform,
	state: DrawState,
) {
	const dpr = window.devicePixelRatio ?? 1;
	const cssW = container.clientWidth;
	const cssH = container.clientHeight;
	if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
		canvas.width = cssW * dpr;
		canvas.height = cssH * dpr;
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.save();
	ctx.scale(dpr, dpr);

	const computed = getComputedStyle(container);
	const bg = computed.getPropertyValue("--sidebar").trim() || "#f8f9fc";
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, cssW, cssH);

	ctx.translate(transform.x, transform.y);
	ctx.scale(transform.k, transform.k);

	drawDotGrid(ctx, transform, cssW, cssH);

	const neighborhood = computeNeighborhood(state.graph, state.selectedId);
	drawEdges(ctx, state, neighborhood);
	drawNodes(ctx, state, neighborhood);

	ctx.restore();
}

function drawDotGrid(
	ctx: CanvasRenderingContext2D,
	transform: ZoomTransform,
	viewportW: number,
	viewportH: number,
) {
	const k = transform.k;
	if (DOT_WORLD_SPACING * k < DOT_MIN_SCREEN_SPACING) return;

	const [worldX0, worldY0] = transform.invert([0, 0]);
	const [worldX1, worldY1] = transform.invert([viewportW, viewportH]);

	const startX = Math.floor(worldX0 / DOT_WORLD_SPACING) * DOT_WORLD_SPACING;
	const startY = Math.floor(worldY0 / DOT_WORLD_SPACING) * DOT_WORLD_SPACING;
	const endX = Math.ceil(worldX1 / DOT_WORLD_SPACING) * DOT_WORLD_SPACING;
	const endY = Math.ceil(worldY1 / DOT_WORLD_SPACING) * DOT_WORLD_SPACING;

	// 1.5px on screen regardless of zoom, so the pattern reads as fine
	// graph paper rather than scaling clumps when the user zooms in.
	const dotSize = 1.5 / k;
	const half = dotSize / 2;

	ctx.fillStyle = "rgba(120, 120, 130, 0.35)";
	for (let x = startX; x <= endX; x += DOT_WORLD_SPACING) {
		for (let y = startY; y <= endY; y += DOT_WORLD_SPACING) {
			ctx.fillRect(x - half, y - half, dotSize, dotSize);
		}
	}
}

function drawEdges(
	ctx: CanvasRenderingContext2D,
	state: DrawState,
	neighborhood: Neighborhood | null,
) {
	for (const e of state.graph.edges) {
		const fp = state.positions.get(e.from);
		const tp = state.positions.get(e.to);
		if (!fp || !tp) continue;
		const fromLayout = state.nodeLayouts.get(e.from);
		const toLayout = state.nodeLayouts.get(e.to);
		const fromW = fromLayout?.w ?? CARD_W;
		const fromH = fromLayout?.h ?? CARD_H_MIN;
		const toW = toLayout?.w ?? CARD_W;
		const toH = toLayout?.h ?? CARD_H_MIN;

		const inN = neighborhood?.edgeIds.has(e.id) ?? false;
		const dimmed = !!neighborhood && !inN;
		const style = RELATION_STYLE[e.relation];

		const fromCx = fp.x + fromW / 2;
		const fromCy = fp.y + fromH / 2;
		const toCx = tp.x + toW / 2;
		const toCy = tp.y + toH / 2;
		const ctrl = bezierControls(fromCx, fromCy, toCx, toCy);

		ctx.save();
		if (style.dashed) ctx.setLineDash([6, 5]);

		ctx.beginPath();
		ctx.moveTo(fromCx, fromCy);
		ctx.bezierCurveTo(ctrl.cp1x, ctrl.cp1y, ctrl.cp2x, ctrl.cp2y, toCx, toCy);

		ctx.strokeStyle = style.color;
		if (dimmed) {
			ctx.globalAlpha = 0.15;
			ctx.lineWidth = style.width;
		} else if (inN) {
			ctx.globalAlpha = 1;
			ctx.lineWidth = Math.max(2, style.width + 0.75);
		} else {
			ctx.globalAlpha = 0.65;
			ctx.lineWidth = style.width;
		}
		ctx.stroke();
		ctx.restore();
	}
}

/**
 * Pick bezier control points that exit the source endpoint along the
 * dominant axis (horizontal vs vertical) of the connection. Edges look
 * like they leave each card from its closest face, instead of always
 * bowing out horizontally regardless of orientation.
 */
function bezierControls(
	fromCx: number,
	fromCy: number,
	toCx: number,
	toCy: number,
) {
	const dx = toCx - fromCx;
	const dy = toCy - fromCy;
	const offset = Math.max(40, Math.hypot(dx, dy) * 0.3);
	if (Math.abs(dx) >= Math.abs(dy)) {
		const sign = dx >= 0 ? 1 : -1;
		return {
			cp1x: fromCx + sign * offset,
			cp1y: fromCy,
			cp2x: toCx - sign * offset,
			cp2y: toCy,
		};
	}
	const sign = dy >= 0 ? 1 : -1;
	return {
		cp1x: fromCx,
		cp1y: fromCy + sign * offset,
		cp2x: toCx,
		cp2y: toCy - sign * offset,
	};
}

function drawNodes(
	ctx: CanvasRenderingContext2D,
	state: DrawState,
	neighborhood: Neighborhood | null,
) {
	for (const n of state.graph.nodes) {
		const p = state.positions.get(n.id);
		const layout = state.nodeLayouts.get(n.id);
		if (!p || !layout) continue;

		const inN = neighborhood?.nodeIds.has(n.id) ?? false;
		const dimmed = !!neighborhood && !inN;
		const focused = n.id === state.selectedId;
		const aiTouched = state.highlightIds.has(n.id);
		const color = TYPE_COLOR[n.type];

		ctx.save();
		if (dimmed) ctx.globalAlpha = 0.3;

		drawNodeFrame(ctx, p.x, p.y, layout.w, layout.h, {
			focused,
			aiTouched,
			inN,
		});
		drawTypeDecorations(ctx, n, p.x, p.y, layout, color);
		drawTextBlock(ctx, p.x, p.y, layout);

		ctx.restore();
	}
}

interface FrameState {
	focused: boolean;
	aiTouched: boolean;
	inN: boolean;
}

function drawNodeFrame(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	state: FrameState,
) {
	// Single-line nodes get full pill geometry (radius = h/2). Taller nodes
	// keep the same maximum radius so the corners still feel rounded but the
	// shape transitions naturally from pill → rounded rect.
	const r = Math.min(h / 2, CARD_R_MAX);
	roundRect(ctx, x, y, w, h, r);
	ctx.fillStyle = "#ffffff";
	ctx.fill();
	ctx.lineWidth = state.focused ? 2.5 : state.aiTouched ? 2 : 1;
	ctx.strokeStyle = state.aiTouched
		? "rgba(52, 211, 153, 0.9)"
		: state.focused
			? "rgba(99, 102, 241, 0.9)"
			: state.inN
				? "rgba(99, 102, 241, 0.5)"
				: "rgba(0, 0, 0, 0.12)";
	ctx.stroke();
}

function drawTextBlock(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	layout: NodeLayout,
) {
	const labelH = layout.labelLines.length * LABEL_LINE_HEIGHT;
	const descH =
		layout.descLines.length > 0
			? TITLE_DESC_GAP + layout.descLines.length * DESC_LINE_HEIGHT
			: 0;
	const totalH = labelH + descH;
	let textY = y + (layout.h - totalH) / 2 + 1;

	ctx.textBaseline = "top";
	ctx.fillStyle = "#111827";
	ctx.font = LABEL_FONT;
	for (const line of layout.labelLines) {
		ctx.fillText(line, x + layout.leftPad, textY);
		textY += LABEL_LINE_HEIGHT;
	}

	if (layout.descLines.length > 0) {
		textY += TITLE_DESC_GAP;
		ctx.fillStyle = "rgba(75, 85, 99, 0.85)";
		ctx.font = DESC_FONT;
		for (const line of layout.descLines) {
			ctx.fillText(line, x + layout.leftPad, textY);
			textY += DESC_LINE_HEIGHT;
		}
	}

	ctx.textBaseline = "alphabetic";
}

function drawTypeDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	switch (n.type) {
		case "person":
			drawPersonDecorations(ctx, n, x, y, layout, color);
			break;
		case "decision":
			drawDecisionDecorations(ctx, x, y, layout, color);
			break;
		case "risk":
			drawRiskDecorations(ctx, n, x, y, layout, color);
			break;
		case "metric":
			drawMetricDecorations(ctx, n, x, y, layout, color);
			break;
		case "event":
			drawEventDecorations(ctx, n, x, y, layout, color);
			break;
		default:
			drawDefaultDecorations(ctx, n, x, y, layout, color);
	}
}

function drawDefaultDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	const cy = y + layout.h / 2;
	ctx.beginPath();
	ctx.arc(x + DOT_CX_OFFSET, cy, DOT_R, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.fill();

	ctx.fillStyle = "rgba(107, 114, 128, 0.7)";
	ctx.font = "600 8px system-ui, sans-serif";
	ctx.textBaseline = "middle";
	ctx.textAlign = "right";
	ctx.fillText(n.type.toUpperCase(), x + layout.w - PILL_PAD_X, cy + 1);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
}

function drawPersonDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	const avR = 22;
	const avCx = x + avR + 4;
	const avCy = y + layout.h / 2;

	ctx.beginPath();
	ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.fill();

	ctx.fillStyle = "#ffffff";
	ctx.font = "700 14px system-ui, sans-serif";
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";
	ctx.fillText(getInitials(n.label), avCx, avCy + 1);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
}

function drawDecisionDecorations(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	const cy = y + layout.h / 2;
	const text = "DECIDED";
	ctx.font = "700 9px system-ui, sans-serif";
	const textW = ctx.measureText(text).width;
	const badgeW = textW + 14;
	const badgeH = 20;
	const badgeX = x + 10;
	const badgeY = cy - badgeH / 2;

	roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
	ctx.fillStyle = color;
	ctx.fill();

	ctx.fillStyle = "#ffffff";
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";
	ctx.fillText(text, badgeX + badgeW / 2, cy + 1);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
}

function drawRiskDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	const cy = y + layout.h / 2;

	ctx.beginPath();
	ctx.arc(x + DOT_CX_OFFSET, cy, DOT_R, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.fill();

	const rightEdge = x + layout.w - PILL_PAD_X;
	const impactCx = rightEdge - SEV_DOT_R;
	const likelihoodCx = impactCx - SEV_DOT_R * 2 - SEV_DOT_GAP;

	ctx.beginPath();
	ctx.arc(likelihoodCx, cy, SEV_DOT_R, 0, Math.PI * 2);
	ctx.fillStyle = SEVERITY_COLOR[n.likelihood ?? "low"];
	ctx.fill();

	ctx.beginPath();
	ctx.arc(impactCx, cy, SEV_DOT_R, 0, Math.PI * 2);
	ctx.fillStyle = SEVERITY_COLOR[n.impact ?? "low"];
	ctx.fill();
}

function drawMetricDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	if (!n.value) {
		drawDefaultDecorations(ctx, n, x, y, layout, color);
		return;
	}
	const cy = y + layout.h / 2;

	ctx.fillStyle = color;
	ctx.font = "700 17px system-ui, sans-serif";
	ctx.textBaseline = "middle";
	ctx.fillText(n.value, x + 18, cy + 1);

	if (n.target) {
		ctx.fillStyle = "rgba(107, 114, 128, 0.85)";
		ctx.font = "500 11px system-ui, sans-serif";
		ctx.textAlign = "right";
		ctx.fillText(`/ ${n.target}`, x + layout.w - PILL_PAD_X, cy + 1);
		ctx.textAlign = "left";
	}
	ctx.textBaseline = "alphabetic";
}

function drawEventDecorations(
	ctx: CanvasRenderingContext2D,
	n: AzNode,
	x: number,
	y: number,
	layout: NodeLayout,
	color: string,
) {
	const cy = y + layout.h / 2;
	ctx.beginPath();
	ctx.arc(x + DOT_CX_OFFSET, cy, DOT_R, 0, Math.PI * 2);
	ctx.fillStyle = color;
	ctx.fill();

	if (n.occurredAt) {
		const dateText = formatEventDate(n.occurredAt);
		ctx.fillStyle = color;
		ctx.font = "600 11px system-ui, sans-serif";
		ctx.textBaseline = "middle";
		ctx.textAlign = "right";
		ctx.fillText(dateText, x + layout.w - PILL_PAD_X, cy + 1);
		ctx.textAlign = "left";
		ctx.textBaseline = "alphabetic";
	}
}

function getInitials(label: string): string {
	const parts = label
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((p) => p[0] ?? "");
	return parts.join("").toUpperCase() || "?";
}

function formatEventDate(occurredAt: string): string {
	const d = new Date(occurredAt);
	if (!Number.isNaN(d.getTime())) {
		const m = d.toLocaleString("en-US", { month: "short" });
		return `${m} ${d.getDate()}`;
	}
	return occurredAt.length > 14 ? `${occurredAt.slice(0, 12)}…` : occurredAt;
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}
