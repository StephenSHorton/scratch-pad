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
	// AIZ-12 — richer vocabulary
	"risk",
	"assumption",
	"constraint",
	"hypothesis",
	"metric",
	"artifact",
	"event",
	"sentiment",
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
	// AIZ-12 — richer vocabulary
	"causes",
	"contradicts",
	"supports",
	"example_of",
	"alternative_to",
	"precedes",
	"resolves",
	"clarifies",
]);
export type EdgeRelation = z.infer<typeof EdgeRelation>;

export const NodeStatus = z.enum(["active", "resolved", "parked"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

/**
 * AIZ-12 — coordinates on the meeting canvas. The AI picks these so the
 * graph reads as a real mind-map (related nodes near each other, central
 * topics in the middle, branches out, room to breathe). Optional —
 * unset means "fall back to auto-layout" on the renderer side.
 *
 * Coordinate space: x and y in pixels. The canvas extends as wide as
 * the AI needs; ReactFlow handles panning. A single node is ~384×140,
 * so leave at least 80–120px of whitespace between cards.
 */
export const NodePosition = z.object({
	x: z.number(),
	y: z.number(),
});
export type NodePosition = z.infer<typeof NodePosition>;

export const NodeConfidence = z.enum(["high", "medium", "low"]);
export type NodeConfidence = z.infer<typeof NodeConfidence>;

export const Severity = z.enum(["low", "medium", "high"]);
export type Severity = z.infer<typeof Severity>;

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
	status: NodeStatus.optional().describe(
		"Does this still need attention? 'active' (default), 'resolved' (answered/unblocked), 'parked' (set aside).",
	),
	confidence: NodeConfidence.optional().describe(
		"How sure you are about this extraction. Default 'high'; use 'medium'/'low' when the speaker is hedging or you're inferring.",
	),
	quote: z
		.string()
		.max(200)
		.optional()
		.describe(
			"Verbatim transcript snippet (≤200 chars) that grounded this node. Use the speaker's actual words, not a paraphrase.",
		),
	tags: z
		.array(z.string())
		.optional()
		.describe(
			"Free-form labels — lowercase, single words or hyphenated. Invent as needed (e.g. 'security', 'q3', 'customer-driven').",
		),
	// AIZ-12 — type-specific structured fields. All optional and additive;
	// each one only applies to certain node types but lives flat on Node so
	// the model has a single shape to fill.
	likelihood: Severity.optional().describe(
		"For `risk` nodes — how likely the bad outcome is. Set alongside `impact`.",
	),
	impact: Severity.optional().describe(
		"For `risk` nodes — how bad the outcome would be if it happens.",
	),
	prediction: z
		.string()
		.optional()
		.describe(
			"For `hypothesis` nodes — the predicted outcome (the 'then' half of 'if X then Y'). Keep terse.",
		),
	value: z
		.string()
		.optional()
		.describe(
			"For `metric` nodes — the headline number/value as the speaker said it (e.g. '180ms', '30%', '$4.2M'). String, not parsed.",
		),
	target: z
		.string()
		.optional()
		.describe(
			"For `metric` nodes — the target/threshold being compared against (e.g. '200ms', '5%').",
		),
	unit: z
		.string()
		.optional()
		.describe(
			"For `metric` nodes — unit when separable (e.g. 'ms', '%', 'requests/sec'). Often baked into `value` instead; only set when calling it out.",
		),
	occurredAt: z
		.string()
		.optional()
		.describe(
			"For `event` nodes — when this happened/will happen. Use ISO date when known (2026-04-12) or natural language otherwise ('last Tuesday', 'next sprint').",
		),
	limit: z
		.string()
		.optional()
		.describe(
			"For `constraint` nodes — the actual hard limit ('Friday EOD', '$100k', 'no PII in logs'). The headline value the constraint enforces.",
		),
	dueDate: z
		.string()
		.optional()
		.describe(
			"For `action_item` nodes — when this is due. ISO date when stated, otherwise natural language ('end of week').",
		),
	tone: z
		.string()
		.optional()
		.describe(
			"For `sentiment` nodes — the emotion as a single word ('frustrated', 'excited', 'uncertain', 'aligned'). The label is the topic; tone is the emotion about it.",
		),
	alternative: z
		.string()
		.optional()
		.describe(
			"For `decision` nodes — the rejected option, when one was explicitly weighed and dropped ('chose Postgres over MySQL' → alternative: 'MySQL').",
		),
	position: NodePosition.optional().describe(
		"Where this node sits on the canvas {x, y} in pixels. Set this so the graph reads as a real mind-map — group related nodes near each other, leave whitespace, avoid overlap. Once set, reuse the same position across passes unless you're intentionally re-arranging.",
	),
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
	status: NodeStatus.optional(),
	confidence: NodeConfidence.optional(),
	quote: z.string().max(200).optional(),
	tags: z.array(z.string()).optional(),
	likelihood: Severity.optional(),
	impact: Severity.optional(),
	prediction: z.string().optional(),
	value: z.string().optional(),
	target: z.string().optional(),
	unit: z.string().optional(),
	occurredAt: z.string().optional(),
	limit: z.string().optional(),
	dueDate: z.string().optional(),
	tone: z.string().optional(),
	alternative: z.string().optional(),
	position: NodePosition.optional(),
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
		.describe(
			"Edge ids to drop. Use when an earlier relation no longer holds.",
		),
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
			...(u.status !== undefined && { status: u.status }),
			...(u.confidence !== undefined && { confidence: u.confidence }),
			...(u.quote !== undefined && { quote: u.quote }),
			...(u.tags !== undefined && { tags: u.tags }),
			...(u.likelihood !== undefined && { likelihood: u.likelihood }),
			...(u.impact !== undefined && { impact: u.impact }),
			...(u.prediction !== undefined && { prediction: u.prediction }),
			...(u.value !== undefined && { value: u.value }),
			...(u.target !== undefined && { target: u.target }),
			...(u.unit !== undefined && { unit: u.unit }),
			...(u.occurredAt !== undefined && { occurredAt: u.occurredAt }),
			...(u.limit !== undefined && { limit: u.limit }),
			...(u.dueDate !== undefined && { dueDate: u.dueDate }),
			...(u.tone !== undefined && { tone: u.tone }),
			...(u.alternative !== undefined && { alternative: u.alternative }),
			...(u.position !== undefined && { position: u.position }),
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
