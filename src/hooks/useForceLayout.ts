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
// Focus-mode "buffer zone" radius around world (0,0). Dimmed/pinned nodes
// inside this radius get nudged outward along their current angle so they
// don't overlap the focused subgraph rearranging at the centre.
const FOCUS_BUFFER_RADIUS = 700;

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
	 * MeetingCanvas waits on this so it only fires fitView when the nodes
	 * have actually stopped moving — otherwise the camera frames mid-flight
	 * positions the simulation immediately leaves behind.
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

/**
 * AIZ-48 — focus-mode helper. Returns the set of node IDs that make up the
 * focused node's 1-hop neighborhood (the focused node itself + every direct
 * neighbor). Used to drive the pin/unpin pattern that pulls neighbors to
 * the focused node and freezes everything outside the neighborhood in place.
 */
function neighborhoodIds(graph: Graph, focused: string): Set<string> {
	const ids = new Set<string>([focused]);
	for (const e of graph.edges) {
		if (e.from === focused) ids.add(e.to);
		else if (e.to === focused) ids.add(e.from);
	}
	return ids;
}

/**
 * AIZ-48 — focus-mode collision force. Like d3's forceCollide but only checks
 * pairs where both nodes pass the `isActive` predicate. In focus mode the
 * highlighted neighborhood would otherwise still avoid the pinned, dimmed
 * nodes via collide (and forceCollide's per-node radius isn't enough — a
 * radius-0 frozen node still acts as a point the active node's radius pushes
 * away from). With this, the focused subgraph re-arranges as if the rest of
 * the graph isn't there, while the pinned nodes hold their positions
 * untouched. O(N²) per tick on the active subset; for ≤20 neighbors that's
 * 400 distance checks, which is negligible.
 */
/**
 * AIZ-48 — focus-mode buffer force. In focus mode the dimmed (pinned) nodes
 * outside the neighborhood that happen to sit near the focus centre would
 * visually overlap with the active subgraph rearranging itself there. This
 * force lerps each dimmed node's pinned position outward along its current
 * angle until it sits at or beyond `bufferRadius`, clearing the centre. The
 * 0.08 per-tick easing combines with d3's velocityDecay so the push-out
 * animates smoothly rather than snapping. Active (in-neighborhood) nodes
 * are skipped — the buffer only acts on the dimmed surrounding ring.
 */
function focusBuffer(
	bufferRadius: number,
	isActive: (node: SimNode) => boolean,
) {
	let nodes: SimNode[] = [];

	const force = function (this: unknown) {
		for (const n of nodes) {
			if (isActive(n)) continue;
			const fx = n.fx ?? n.x ?? 0;
			const fy = n.fy ?? n.y ?? 0;
			const r = Math.hypot(fx, fy);
			if (r >= bufferRadius || r === 0) continue;
			const scale = bufferRadius / r;
			const targetX = fx * scale;
			const targetY = fy * scale;
			n.fx = fx + (targetX - fx) * 0.08;
			n.fy = fy + (targetY - fy) * 0.08;
		}
	};
	(force as unknown as { initialize: (nodes: SimNode[]) => void }).initialize =
		(n) => {
			nodes = n;
		};
	return force;
}

function focusCollide(
	radius: number,
	strength: number,
	isActive: (node: SimNode) => boolean,
) {
	let active: SimNode[] = [];
	const minDist = radius * 2;
	const minDist2 = minDist * minDist;

	const force = function (this: unknown) {
		for (let i = 0; i < active.length; i++) {
			const a = active[i];
			const ax = a.x ?? 0;
			const ay = a.y ?? 0;
			for (let j = i + 1; j < active.length; j++) {
				const b = active[j];
				const dx = (b.x ?? 0) - ax;
				const dy = (b.y ?? 0) - ay;
				const d2 = dx * dx + dy * dy;
				if (d2 >= minDist2 || d2 === 0) continue;
				const dist = Math.sqrt(d2);
				const overlap = ((minDist - dist) / dist) * strength * 0.5;
				const ox = dx * overlap;
				const oy = dy * overlap;
				a.vx = (a.vx ?? 0) - ox;
				a.vy = (a.vy ?? 0) - oy;
				b.vx = (b.vx ?? 0) + ox;
				b.vy = (b.vy ?? 0) + oy;
			}
		}
	};
	(force as unknown as { initialize: (nodes: SimNode[]) => void }).initialize =
		(nodes) => {
			active = nodes.filter(isActive);
		};
	return force;
}

export function useForceLayout(
	graph: Graph,
	selectedId: string | null = null,
): ForceLayoutResult {
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
	// Tracks the previous selectedId across runs so we can detect entering
	// vs. leaving focus mode and use a higher alpha bump on the transition
	// — the snappier-than-default settle is what gives the "flick" feel.
	const previousSelectedRef = useRef<string | null>(null);

	useEffect(() => {
		// In focus mode the focused node is the de-facto hub (pinned at 0,0),
		// the radial-BFS layout is suspended, and every node outside the 1-hop
		// neighborhood is pinned at its current position so the rest of the
		// graph holds still. On unfocus, the original hub re-claims (0,0) and
		// the regular BFS-radial structure rebuilds with an alpha bump for a
		// spring-back into the full layout.
		const focused = selectedId ?? null;
		const neighborhood = focused ? neighborhoodIds(graph, focused) : null;

		// Find the most-connected node — only meaningful in normal (unfocused)
		// mode. In focus mode, the focused node takes the origin instead.
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

		// Build/refresh the SimNode set, preserving positions for nodes that
		// already existed. Pinning depends on focus state:
		//   - focus mode: focused node fx/fy = (0,0); neighbors free; everyone
		//     else pinned at their current x/y so they don't drift away.
		//   - normal mode: hub fx/fy = (0,0); everyone else free.
		const next = new Map<string, SimNode>();
		for (const n of graph.nodes) {
			const existing = nodesRef.current.get(n.id);
			let node: SimNode;
			if (existing) {
				node = existing;
			} else {
				const seed = seedPosition(n.id, graph, nodesRef.current);
				node = { id: n.id, x: seed.x, y: seed.y };
			}

			if (focused) {
				if (n.id === focused) {
					node.fx = 0;
					node.fy = 0;
				} else if (neighborhood?.has(n.id)) {
					node.fx = null;
					node.fy = null;
				} else {
					// Pin at current position so the rest of the graph holds.
					// Falls back to (0,0) only for nodes that just appeared
					// in the graph and haven't been ticked yet.
					node.fx = node.x ?? 0;
					node.fy = node.y ?? 0;
				}
			} else {
				if (n.id === hubId) {
					node.fx = 0;
					node.fy = 0;
				} else {
					node.fx = null;
					node.fy = null;
				}
			}
			next.set(n.id, node);
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

		// In focus mode, charge and collide are filtered to ignore non-
		// neighborhood nodes. Charge uses per-node strength=0 for the dimmed
		// nodes (built into d3's forceManyBody — a strength-0 node contributes
		// nothing to the force field). Collide uses a custom replacement
		// because forceCollide's per-node radius doesn't actually exclude a
		// node from the simulation; the subgraph would still avoid the pinned
		// dim nodes' point positions otherwise.
		const chargeStrength: (n: SimNode) => number =
			focused && neighborhood
				? (n) => (neighborhood.has(n.id) ? -600 : 0)
				: () => -600;
		const charge = forceManyBody<SimNode>().strength(chargeStrength);

		const collide =
			focused && neighborhood
				? focusCollide(COLLISION_RADIUS, 0.9, (n) => neighborhood.has(n.id))
				: forceCollide<SimNode>(COLLISION_RADIUS).strength(0.9);

		// Buffer force only runs in focus mode. `null` clears it on unfocus
		// so the dimmed nodes stay where d3-force last placed them as they
		// snap back into the full layout.
		const buffer =
			focused && neighborhood
				? focusBuffer(FOCUS_BUFFER_RADIUS, (n) => neighborhood.has(n.id))
				: null;

		// BFS-radial — every node connected to the hub gets pulled to a
		// ring at distance (bfs depth × RING_SPACING). Disabled in focus mode
		// because the rings are anchored on the original hub, which would
		// fight the focused node for the centre. Without the radial, link +
		// charge + collide give a clean local force-directed layout for the
		// neighborhood around the pinned focused node.
		const bfsDist = bfsDistances(graph, hubId);
		const radial = focused
			? null
			: forceRadial<SimNode>(
					(d) => {
						const r = bfsDist.get(d.id);
						return r !== undefined
							? r * RING_SPACING
							: DISCONNECTED_RADIUS_FALLBACK;
					},
					0,
					0,
				).strength((d) => (bfsDist.has(d.id) ? 0.6 : 0.05));

		// Alpha bump magnitude. Focus enter/leave gets a noticeably higher
		// kick so the neighborhood actually flicks; ordinary graph mutations
		// stay at the gentler default so AI-added nodes don't punch the
		// existing layout around.
		const focusChanged = focused !== previousSelectedRef.current;
		previousSelectedRef.current = focused;
		const alphaBump = focusChanged ? 0.85 : 0.6;

		// Per-tick velocity damping. d3's default is 0.4; we run heavier so
		// node motion feels more deliberate. Reapplied on every update so
		// HMR-driven tweaks to this number take effect on the existing
		// simulation instance (otherwise the value would only land on a
		// fresh page load).
		const VELOCITY_DECAY = 0.85;

		if (!simRef.current) {
			simRef.current = forceSimulation<SimNode, SimLink>(simNodes)
				.force("link", link)
				.force("charge", charge)
				.force("radial", radial)
				.force("collide", collide)
				.force("buffer", buffer)
				.alphaDecay(0.05)
				.velocityDecay(VELOCITY_DECAY)
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
			// Charge, collide, radial, and buffer all swap between focus and
			// normal mode whenever selectedId toggles, so they have to be
			// re-attached on every update — passing `null` removes a force,
			// which is how unfocus clears radial and buffer.
			simRef.current.force("charge", charge);
			simRef.current.force("radial", radial);
			simRef.current.force("collide", collide);
			simRef.current.force("buffer", buffer);
			simRef.current.velocityDecay(VELOCITY_DECAY).alpha(alphaBump).restart();
		}
	}, [graph, selectedId]);

	useEffect(() => {
		return () => {
			simRef.current?.stop();
			simRef.current = null;
		};
	}, []);

	return { positions, settledAt };
}
