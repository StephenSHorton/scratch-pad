import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import { useEffect, useRef, useState } from "react";
import type { EdgeRelation, Graph } from "@/lib/aizuchi/schemas";

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

const RELATION_LINK: Record<
	EdgeRelation,
	{ distance: number; strength: number }
> = {
	owns: { distance: 280, strength: 0.6 },
	depends_on: { distance: 280, strength: 0.55 },
	blocks: { distance: 240, strength: 0.7 },
	related_to: { distance: 360, strength: 0.25 },
	decides: { distance: 260, strength: 0.55 },
	asks: { distance: 240, strength: 0.5 },
	answers: { distance: 240, strength: 0.6 },
	mentions: { distance: 380, strength: 0.2 },
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
}

type SimLink = SimulationLinkDatum<SimNode>;

export type PositionMap = ReadonlyMap<string, { x: number; y: number }>;

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

export function useForceLayout(graph: Graph): PositionMap {
	const [positions, setPositions] = useState<PositionMap>(new Map());
	const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
	// Persisted node refs — d3 mutates x/y/vx/vy on these, so reusing the
	// same object across renders preserves the simulation state for nodes
	// that didn't change.
	const nodesRef = useRef<Map<string, SimNode>>(new Map());

	useEffect(() => {
		// Build/refresh the SimNode set, preserving positions for nodes
		// that already existed.
		const next = new Map<string, SimNode>();
		for (const n of graph.nodes) {
			const existing = nodesRef.current.get(n.id);
			if (existing) {
				next.set(n.id, existing);
			} else {
				const seed = seedPosition(n.id, graph, nodesRef.current);
				next.set(n.id, { id: n.id, x: seed.x, y: seed.y });
			}
		}
		nodesRef.current = next;
		const simNodes = [...next.values()];

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

		if (!simRef.current) {
			simRef.current = forceSimulation<SimNode, SimLink>(simNodes)
				.force("link", link)
				.force("charge", forceManyBody<SimNode>().strength(-1400))
				.force("center", forceCenter(0, 0).strength(0.05))
				.force("collide", forceCollide<SimNode>(COLLISION_RADIUS).strength(0.9))
				.alphaDecay(0.05)
				.alphaMin(0.002)
				.on("tick", () => {
					const out = new Map<string, { x: number; y: number }>();
					for (const sn of simNodes) {
						out.set(sn.id, { x: sn.x ?? 0, y: sn.y ?? 0 });
					}
					setPositions(out);
				});
		} else {
			simRef.current.nodes(simNodes);
			simRef.current.force("link", link);
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

	return positions;
}
