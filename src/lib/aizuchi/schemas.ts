import { z } from "zod";

export const NodeType = z.enum([
	"person",
	"topic",
	"work_item",
	"blocker",
	"decision",
	"action_item",
	"question",
	"context",
]);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeRelation = z.enum([
	"owns",
	"depends_on",
	"blocks",
	"related_to",
	"decides",
	"asks",
	"answers",
	"mentions",
	"assigned_to",
]);
export type EdgeRelation = z.infer<typeof EdgeRelation>;

export const Node = z.object({
	id: z
		.string()
		.describe(
			"Stable identifier. Use snake_case slugs derived from the label, e.g. 'travis_chen', 'migration_blocker'. Must be unique.",
		),
	label: z.string().describe("Short human-readable label shown on the map."),
	type: NodeType,
	description: z
		.string()
		.optional()
		.describe("Optional short context for the node (one sentence)."),
	speaker: z
		.string()
		.optional()
		.describe("Who introduced or owns this in the meeting, if attributable."),
});
export type Node = z.infer<typeof Node>;

export const Edge = z.object({
	id: z
		.string()
		.describe("Stable identifier, e.g. 'travis_chen-owns-payments_migration'."),
	from: z.string().describe("Source node id."),
	to: z.string().describe("Target node id."),
	relation: EdgeRelation,
	description: z.string().optional(),
});
export type Edge = z.infer<typeof Edge>;

export const Graph = z.object({
	nodes: z.array(Node),
	edges: z.array(Edge),
});
export type Graph = z.infer<typeof Graph>;

export const NodeUpdate = z.object({
	id: z.string(),
	label: z.string().optional(),
	description: z.string().optional(),
	type: NodeType.optional(),
});
export type NodeUpdate = z.infer<typeof NodeUpdate>;

export const NodeMerge = z.object({
	keep: z.string().describe("Id of the node to keep."),
	absorb: z
		.array(z.string())
		.describe(
			"Ids of duplicate/equivalent nodes to merge into 'keep'. Edges touching absorbed nodes are rewired to 'keep' automatically; do not re-emit them as add_edges.",
		),
});
export type NodeMerge = z.infer<typeof NodeMerge>;

export const GraphDiff = z.object({
	no_changes: z
		.boolean()
		.describe(
			"True when the new transcript chunk contains no information worth adding or modifying in the graph. When true, all other arrays must be empty.",
		),
	add_nodes: z.array(Node),
	add_edges: z.array(Edge),
	update_nodes: z.array(NodeUpdate),
	merge_nodes: z.array(NodeMerge),
});
export type GraphDiff = z.infer<typeof GraphDiff>;

export interface TranscriptChunk {
	speaker: string;
	text: string;
	startMs: number;
	endMs: number;
}

export function emptyGraph(): Graph {
	return { nodes: [], edges: [] };
}

export function applyDiff(graph: Graph, diff: GraphDiff): Graph {
	if (diff.no_changes) return graph;

	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	const edges = new Map(graph.edges.map((e) => [e.id, e]));

	for (const m of diff.merge_nodes) {
		const absorbed = new Set(m.absorb);
		for (const id of absorbed) nodes.delete(id);
		for (const [eid, e] of edges) {
			let next = e;
			if (absorbed.has(e.from)) next = { ...next, from: m.keep };
			if (absorbed.has(e.to)) next = { ...next, to: m.keep };
			if (next !== e) edges.set(eid, next);
		}
	}

	// Drop self-loops produced by merges (e.g. "tim mentions travis" becomes
	// "travis mentions travis" after a tim→travis merge).
	for (const [eid, e] of edges) {
		if (e.from === e.to) edges.delete(eid);
	}

	for (const u of diff.update_nodes) {
		const existing = nodes.get(u.id);
		if (!existing) continue;
		nodes.set(u.id, {
			...existing,
			...(u.label !== undefined && { label: u.label }),
			...(u.description !== undefined && { description: u.description }),
			...(u.type !== undefined && { type: u.type }),
		});
	}

	for (const n of diff.add_nodes) {
		if (!nodes.has(n.id)) nodes.set(n.id, n);
	}

	for (const e of diff.add_edges) {
		if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
		if (!edges.has(e.id)) edges.set(e.id, e);
	}

	return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
