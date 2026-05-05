import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useRef, useState } from "react";
import type { EdgeRelation, Graph, NodeType } from "@/lib/aizuchi/schemas";

/**
 * AIZ-12 — d3-force-driven layout for the meeting canvas. Replaces the
 * AI-emitted coordinates that were producing overlapping cards and
 * geometric incoherence (gemma can't see the canvas, so it can't reason
 * spatially). Forces:
 *
 * - **link** — connected nodes pull together; strength varies by relation.
 *   `causes`/`supports`/`resolves`/`clarifies`/`contradicts` cluster
 *   tightly; `related_to`/`mentions` are a soft pull.
 * - **charge** — every node repels every other (Coulomb-style).
 * - **collide** — circular collision radius wider than the card
 *   half-width so cards have breathing room.
 * - **center** — gentle pull to the origin so the graph doesn't drift.
 *
 * The simulation persists across re-renders. New nodes inherit the
 * average position of their connected neighbors (so they don't land
 * far from where they belong) before letting d3 settle them in.
 */

const CARD_W = 384;
const CARD_H = 160;
// Collision radius — half the card diagonal plus padding so cards
// never visually overlap at rest.
const COLLISION_RADIUS = Math.hypot(CARD_W, CARD_H) / 2 + 24;

/**
 * AIZ-12 — soft vertical bands per node type. Mirrors the natural flow
 * of a meeting from top to bottom: who's talking → what they're
 * discussing → uncertainty → substance → outputs/problems. The y-force
 * is gentle (strength 0.06) so connected nodes can still pull
 * cross-band when their relationship demands it; the bands are a
 * preference, not a wall.
 */
const TYPE_Y: Record<NodeType, number> = {
	// Origin / setup
	person: -550,
	topic: -350,
	context: -250,
	// Uncertainty / framing
	assumption: -150,
	hypothesis: -50,
	question: 0,
	// Substance
	work_item: 100,
	decision: 100,
	sentiment: 100,
	// Concrete things
	artifact: 220,
	metric: 220,
	event: 220,
	// Outputs / problems
	blocker: 360,
	risk: 360,
	constraint: 360,
	action_item: 480,
};

const RELATION_LINK: Record<
	EdgeRelation,
	{ distance: number; strength: number }
> = {
	owns: { distance: 280, strength: 0.6 },
	depends_on: { distance: 280, strength: 0.55 },
	blocks: { distance: 240, strength: 0.7 },
	related_to: { distance: 320, strength: 0.4 },
	decides: { distance: 260, strength: 0.55 },
	asks: { distance: 240, strength: 0.5 },
	answers: { distance: 240, strength: 0.6 },
	mentions: { distance: 340, strength: 0.35 },
	assigned_to: { distance: 240, strength: 0.6 },
	causes: { distance: 240, strength: 0.7 },
	contradicts: { distance: 280, strength: 0.6 },
	supports: { distance: 240, strength: 0.7 },
	example_of: { distance: 240, strength: 0.65 },
	alternative_to: { distance: 260, strength: 0.55 },
	precedes: { distance: 260, strength: 0.6 },
	resolves: { distance: 240, strength: 0.7 },
	clarifies: { distance: 240, strength: 0.65 },
};

interface SimNode extends SimulationNodeDatum {
	id: string;
	type: NodeType;
	/** True for the most-connected node in the graph; pulled hard to (0,0)
	 * to anchor the layout. */
	isHub: boolean;
}

type SimLink = SimulationLinkDatum<SimNode>;

export type PositionMap = ReadonlyMap<string, { x: number; y: number }>;

export interface ForceLayoutResult {
	positions: PositionMap;
	/**
	 * Timestamp (Date.now()) of the most recent simulation settle. Updated
	 * each time the sim's `end` event fires (alpha drops below alphaMin).
	 * Consumers like CameraFollower wait on this so they only fire fitView
	 * when the nodes have actually stopped moving — otherwise the camera
	 * frames mid-flight positions the simulation immediately leaves behind.
	 * 0 before any settle has occurred.
	 */
	settledAt: number;
}

/**
 * Pick a starting position for a node that's just appeared in the graph.
 * If the node has any neighbors with known positions, drop it at their
 * centroid plus small jitter so the simulation has a sensible seed
 * instead of starting every new node at (0, 0). Otherwise, jitter
 * around the origin so the charge force doesn't have to push everything
 * apart from the same point.
 */
function seedPosition(
	id: string,
	graph: Graph,
	known: Map<string, SimNode>,
): { x: number; y: number } {
	let sx = 0;
	let sy = 0;
	let n = 0;
	for (const e of graph.edges) {
		const otherId = e.from === id ? e.to : e.to === id ? e.from : null;
		if (!otherId) continue;
		const neighbor = known.get(otherId);
		if (neighbor && neighbor.x !== undefined && neighbor.y !== undefined) {
			sx += neighbor.x;
			sy += neighbor.y;
			n++;
		}
	}
	const jitter = () => (Math.random() - 0.5) * 80;
	if (n === 0) return { x: jitter(), y: jitter() };
	return { x: sx / n + jitter(), y: sy / n + jitter() };
}

export function useForceLayout(graph: Graph): ForceLayoutResult {
	const [positions, setPositions] = useState<PositionMap>(new Map());
	const [settledAt, setSettledAt] = useState(0);
	const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
	// Persisted node refs — d3 mutates x/y/vx/vy on these, so reusing the
	// same object across renders preserves the simulation state for nodes
	// that didn't change.
	const nodesRef = useRef<Map<string, SimNode>>(new Map());
	// Live array the tick callback reads from. Held in a ref so subsequent
	// graph updates (which mutate the simulation via `.nodes()` + restart)
	// don't leave the tick handler iterating the empty array captured the
	// first time the simulation was created.
	const simNodesRef = useRef<SimNode[]>([]);

	useEffect(() => {
		// Find the most-connected node — it'll be pulled to the origin
		// so the rest of the graph orbits around it (Obsidian-style).
		const degrees = new Map<string, number>();
		for (const e of graph.edges) {
			degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1);
			degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1);
		}
		let hubId: string | null = null;
		let maxDegree = 0;
		for (const [id, d] of degrees) {
			if (d > maxDegree) {
				maxDegree = d;
				hubId = id;
			}
		}
		// At least 3 connections to be considered a "hub" — otherwise no
		// single node should hijack the centering force.
		if (maxDegree < 3) hubId = null;

		// Build/refresh the SimNode set, preserving positions for nodes
		// that already existed.
		const next = new Map<string, SimNode>();
		for (const n of graph.nodes) {
			const existing = nodesRef.current.get(n.id);
			const isHub = n.id === hubId;
			if (existing) {
				existing.type = n.type;
				existing.isHub = isHub;
				next.set(n.id, existing);
			} else {
				const seed = seedPosition(n.id, graph, nodesRef.current);
				next.set(n.id, {
					id: n.id,
					type: n.type,
					isHub,
					x: seed.x,
					y: seed.y,
				});
			}
		}
		nodesRef.current = next;
		const simNodes = [...next.values()];
		simNodesRef.current = simNodes;

		// d3-force mutates the link source/target from string ids into
		// node references, so always start from a fresh array to avoid
		// retaining stale links.
		const simLinks: SimLink[] = graph.edges
			.filter((e) => next.has(e.from) && next.has(e.to))
			.map((e) => ({
				source: e.from,
				target: e.to,
				// strength/distance are read off the link force per-edge.
				...RELATION_LINK[e.relation],
			}));

		const link = forceLink<SimNode, SimLink>(simLinks)
			.id((d) => d.id)
			.distance((l) => (l as SimLink & { distance?: number }).distance ?? 280)
			.strength((l) => (l as SimLink & { strength?: number }).strength ?? 0.4);

		// Per-type vertical band — soft pull toward TYPE_Y[type]. Strength
		// 0.06 is a preference, not a constraint; cross-band edges will
		// still pull connected nodes together.
		const typeY = forceY<SimNode>((d) => TYPE_Y[d.type]).strength(0.06);

		// Hub anchor — the most-connected node (if any) is pinned strongly
		// to the origin so the rest of the graph orbits around it. Other
		// nodes get a near-zero force here so the existing center force is
		// the only thing centering them.
		const hubX = forceX<SimNode>(0).strength((d) => (d.isHub ? 0.4 : 0));
		const hubY = forceY<SimNode>(0).strength((d) => (d.isHub ? 0.4 : 0));

		if (!simRef.current) {
			simRef.current = forceSimulation<SimNode, SimLink>(simNodes)
				.force("link", link)
				.force("charge", forceManyBody<SimNode>().strength(-800))
				.force("center", forceCenter(0, 0).strength(0.18))
				.force("collide", forceCollide<SimNode>(COLLISION_RADIUS).strength(0.9))
				.force("typeY", typeY)
				.force("hubX", hubX)
				.force("hubY", hubY)
				.alphaDecay(0.05)
				.alphaMin(0.002)
				.on("tick", () => {
					// Read from the ref, not the closure — `simNodes` here
					// is stale once the simulation is reused for a later
					// graph update via `.nodes(...).restart()`.
					const out = new Map<string, { x: number; y: number }>();
					for (const sn of simNodesRef.current) {
						out.set(sn.id, { x: sn.x ?? 0, y: sn.y ?? 0 });
					}
					setPositions(out);
				})
				.on("end", () => {
					// Fired when alpha drops below alphaMin. Bumping the
					// timestamp lets the camera-follow logic frame the
					// graph at the moment the nodes actually stop moving,
					// instead of mid-flight at the start of a settle.
					setSettledAt(Date.now());
				});
		} else {
			simRef.current.nodes(simNodes);
			simRef.current.force("link", link);
			// Re-attach the per-node forces so they read from the latest
			// SimNode set (each call captures the current `simNodes` via
			// the accessor functions).
			simRef.current.force("typeY", typeY);
			simRef.current.force("hubX", hubX);
			simRef.current.force("hubY", hubY);
			// Bump alpha so newly-added nodes settle in.
			simRef.current.alpha(0.6).restart();
		}
	}, [graph]);

	useEffect(() => {
		return () => {
			simRef.current?.stop();
			simRef.current = null;
		};
	}, []);

	return { positions, settledAt };
}
