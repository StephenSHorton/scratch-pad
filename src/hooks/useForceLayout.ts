import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceRadial,
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

/**
 * AIZ-12 — BFS-radial layout. Pick the most-connected node as the hub
 * (Obsidian's "current note" analog), compute graph distance from it
 * to every other node, then place each node on a ring whose radius is
 * proportional to that distance. Hub at center; first-degree
 * neighbors at ring 1; second-degree at ring 2; and so on. Charge +
 * link forces handle angular distribution within each ring. This gives
 * the "trees with branches" pattern the user asked for: structure
 * grows outward from the conversation's actual gravity.
 */
const RING_SPACING = 380;
const DISCONNECTED_RADIUS_FALLBACK = 3000;

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
 * AIZ-12 — BFS distance from `hubId` to every other node, treating
 * edges as undirected. Returns a map; nodes not reachable from the
 * hub (different component, or `hubId` is null) are absent. Used to
 * place each node on a concentric ring proportional to its graph
 * distance from the conversation's anchor.
 */
function bfsDistances(graph: Graph, hubId: string | null): Map<string, number> {
	const dist = new Map<string, number>();
	if (!hubId) return dist;

	const adj = new Map<string, Set<string>>();
	for (const e of graph.edges) {
		if (!adj.has(e.from)) adj.set(e.from, new Set());
		if (!adj.has(e.to)) adj.set(e.to, new Set());
		adj.get(e.from)?.add(e.to);
		adj.get(e.to)?.add(e.from);
	}

	dist.set(hubId, 0);
	const queue: string[] = [hubId];
	while (queue.length > 0) {
		const cur = queue.shift();
		if (!cur) break;
		const d = dist.get(cur);
		if (d === undefined) continue;
		const neighbors = adj.get(cur);
		if (!neighbors) continue;
		for (const next of neighbors) {
			if (!dist.has(next)) {
				dist.set(next, d + 1);
				queue.push(next);
			}
		}
	}
	return dist;
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
		// that already existed. The hub gets `fx`/`fy` set to (0, 0) so
		// d3-force pins it exactly at the origin — without this, the
		// 9-ish neighbors all repel the hub via charge, nudging it
		// off-center and stretching the rings asymmetrically.
		const next = new Map<string, SimNode>();
		for (const n of graph.nodes) {
			const isHub = n.id === hubId;
			const existing = nodesRef.current.get(n.id);
			if (existing) {
				if (isHub) {
					existing.fx = 0;
					existing.fy = 0;
				} else {
					existing.fx = null;
					existing.fy = null;
				}
				next.set(n.id, existing);
			} else {
				const seed = seedPosition(n.id, graph, nodesRef.current);
				const node: SimNode = { id: n.id, x: seed.x, y: seed.y };
				if (isHub) {
					node.fx = 0;
					node.fy = 0;
				}
				next.set(n.id, node);
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

		// BFS-radial — every node connected to the hub gets pulled to a
		// ring at distance (bfs depth × RING_SPACING). The hub itself
		// sits at radius 0. Strength 0.5 means rings dominate over link
		// forces (max 0.7), so the structure is *tree-like radial*
		// instead of a free-floating cloud. Disconnected sub-graphs get
		// pulled to the perimeter at a weaker strength so their internal
		// links cluster them locally without yanking them off-screen.
		const bfsDist = bfsDistances(graph, hubId);
		const radial = forceRadial<SimNode>(
			(d) => {
				const r = bfsDist.get(d.id);
				return r !== undefined
					? r * RING_SPACING
					: DISCONNECTED_RADIUS_FALLBACK;
			},
			0,
			0,
		).strength((d) => (bfsDist.has(d.id) ? 0.6 : 0.05));

		if (!simRef.current) {
			simRef.current = forceSimulation<SimNode, SimLink>(simNodes)
				.force("link", link)
				.force("charge", forceManyBody<SimNode>().strength(-600))
				.force("radial", radial)
				.force("collide", forceCollide<SimNode>(COLLISION_RADIUS).strength(0.9))
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
			// Re-attach the per-node radial force so it reads from the
			// fresh BFS distances (the hub may have shifted as the AI
			// added new edges).
			simRef.current.force("radial", radial);
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
