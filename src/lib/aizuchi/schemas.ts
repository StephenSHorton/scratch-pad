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

export const ThoughtIntent = z.enum([
	"question",
	"observation",
	"unresolved",
	"pattern",
	"fyi",
]);
export type ThoughtIntent = z.infer<typeof ThoughtIntent>;

export const AIThought = z.object({
	id: z
		.string()
		.describe(
			"Stable identifier — reuse the same id across passes when updating an existing thought. snake_case slug.",
		),
	text: z
		.string()
		.describe("One short sentence — the observation, question, or note."),
	intent: ThoughtIntent.describe(
		"How this thought should be surfaced to the user. 'unresolved' / 'question' draw attention; 'observation' / 'pattern' / 'fyi' are quieter.",
	),
	references: z
		.array(z.string())
		.optional()
		.describe(
			"Optional node ids this thought relates to — clicking these in the UI jumps to the node.",
		),
});
export type AIThought = z.infer<typeof AIThought>;

/** UI-side enrichment — added by the consumer, not the model. */
export interface AIThoughtRecord extends AIThought {
	createdAt: number;
	updatedAt: number;
}

/**
 * One pass of the graph-mutation loop. Used by the meeting transcript UI
 * to interleave AI thoughts with the chunks that prompted them — gives the
 * user a temporal sense of "what the AI was thinking when."
 */
export interface PassRecord {
	id: string;
	batchIdx: number;
	/** Last chunk index (0-based) included in the batch this pass processed. */
	atChunkIdx: number;
	/** New or updated thoughts emitted by this pass. */
	thoughts: AIThought[];
	timestamp: number;
}

export const GraphDiff = z.object({
	no_changes: z
		.boolean()
		.describe(
			"True when this pass produces no graph or notes changes. When true, all other arrays must be empty.",
		),
	add_nodes: z.array(Node),
	add_edges: z.array(Edge),
	update_nodes: z.array(NodeUpdate),
	merge_nodes: z.array(NodeMerge),
	remove_nodes: z
		.array(z.string())
		.describe(
			"Node ids to drop entirely. Use when reclassifying or removing a misextraction. Edges touching removed nodes are dropped automatically.",
		),
	remove_edges: z
		.array(z.string())
		.describe("Edge ids to drop. Use when an earlier relation no longer holds."),
	notes: z
		.array(AIThought)
		.describe(
			"Running observations about the meeting — questions, unresolved threads, patterns. Each thought has a stable id; emit the same id again to update an existing thought, or omit a previous id to drop it.",
		),
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

/** Apply a diff to a graph. Returns the new graph. */
export function applyDiff(graph: Graph, diff: GraphDiff): Graph {
	if (diff.no_changes) return graph;

	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	const edges = new Map(graph.edges.map((e) => [e.id, e]));

	// 1. Merges first (rewire edges, drop absorbed)
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

	// 2. Self-loops cleanup post-merge
	for (const [eid, e] of edges) {
		if (e.from === e.to) edges.delete(eid);
	}

	// 3. Explicit removes
	for (const id of diff.remove_nodes) {
		nodes.delete(id);
	}
	for (const id of diff.remove_edges) {
		edges.delete(id);
	}
	// 4. Drop edges left dangling by node removes
	for (const [eid, e] of edges) {
		if (!nodes.has(e.from) || !nodes.has(e.to)) edges.delete(eid);
	}

	// 5. Updates
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

	// 6. Adds
	for (const n of diff.add_nodes) {
		if (!nodes.has(n.id)) nodes.set(n.id, n);
	}
	for (const e of diff.add_edges) {
		if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
		if (!edges.has(e.id)) edges.set(e.id, e);
	}

	return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Merges thoughts from a diff into the existing UI-side thought list.
 * Same-id thought is replaced (text/intent/references can change), bumps
 * `updatedAt`. Thoughts not present in the diff are KEPT — the model only
 * needs to emit changed/new thoughts. Returns the new list.
 *
 * To explicitly drop a thought, the model emits a `remove_*` style isn't
 * used here; instead, the consumer can prune by age or by absent-from-N-
 * passes if needed. For prototype: cumulative + de-duplicated by id.
 */
export function mergeThoughts(
	existing: AIThoughtRecord[],
	incoming: AIThought[],
	now: number,
): AIThoughtRecord[] {
	const byId = new Map(existing.map((t) => [t.id, t]));
	for (const t of incoming) {
		const prev = byId.get(t.id);
		byId.set(t.id, {
			...t,
			createdAt: prev?.createdAt ?? now,
			updatedAt: now,
		});
	}
	return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
