import type { ExtractionMode } from "./persistence";
import type { Edge, EdgeRelation, Graph, GraphDiff, Node } from "./schemas";

const SPECIFIC_RELATIONS: ReadonlySet<EdgeRelation> = new Set([
	"owns",
	"depends_on",
	"blocks",
	"decides",
	"assigned_to",
	"answers",
]);

/**
 * AIZ-33 — substance-mode meta-commitment patterns. The model keeps
 * surfacing ticket/tracking process-management as `action_item` in
 * substance mode (e.g. "Creating Linear tasks to track updates"). Even
 * with a tightened prompt definition the model rephrases the same
 * meta-commentary; this filter strips them after the fact.
 *
 * These patterns are intentionally narrow — they target the failure
 * mode without filtering legitimate substance action_items like "Ship
 * the Postgres migration by Friday" or "Write a one-pager on the badge
 * UX." Each pattern matches what a "vague" candidate looks like in
 * label or description, NOT in the upstream transcript itself.
 */
const SUBSTANCE_VAGUE_ACTION_PATTERNS: readonly RegExp[] = [
	/\bthe commitment to\b/i,
	/\bcommit(?:ment|ting|s)? to (?:track|create|file|open)\b/i,
	/\bcreat(?:e|ing|ion of)\b[^.]*?\b(?:tasks?|tickets?|issues?|cards?)\b/i,
	/\btrack(?:ing|s)?\b[^.]*?\b(?:these|those|the\s+\w+|necessary|updates?)\b/i,
];

function speakerToId(speaker: string): string {
	return speaker.trim().toLowerCase().replace(/\s+/g, "_");
}

function pairKey(from: string, to: string): string {
	return `${from}|${to}`;
}

export interface NormalizeReport {
	addedPersonNodes: string[];
	droppedRedundantRelatedTo: number;
	droppedTrivialMentions: number;
	droppedSelfLoops: number;
	droppedDuplicateEdges: number;
	droppedPersonMerges: number;
	droppedDuplicateThoughts: number;
	thrashGuardTriggered: boolean;
	droppedVagueActionItems: number;
	addedAssignedToEdges: number;
}

export interface NormalizeResult {
	diff: GraphDiff;
	report: NormalizeReport;
}

/**
 * Reject a diff that would delete more than this fraction of the existing
 * graph in one pass. Catches model-side thrashing where the LLM forgets
 * the cumulative-memory rule and tries to start over.
 */
const THRASH_NODE_REMOVAL_FRACTION = 0.5;

/**
 * Post-process a model-produced diff to handle structural correctness the
 * prompt can't reliably enforce:
 *
 *   1. Auto-create person nodes for any 'speaker' field reference that
 *      lacks a corresponding person node (model frequently forgets this).
 *   2. Drop 'related_to' edges when a more specific edge (owns, depends_on,
 *      blocks, decides, assigned_to, answers) already covers the same pair.
 *   3. Drop 'mentions' edges from a person to a target the same person owns.
 *   4. (AIZ-33) Drop vague action_item nodes that fail the per-mode bar:
 *      attribution requires an `assigned_to` edge; substance rejects
 *      labels/descriptions matching meta-tracking patterns.
 */
export function normalizeDiff(
	graph: Graph,
	diff: GraphDiff,
	mode?: ExtractionMode,
): NormalizeResult {
	const report: NormalizeReport = {
		addedPersonNodes: [],
		droppedRedundantRelatedTo: 0,
		droppedTrivialMentions: 0,
		droppedSelfLoops: 0,
		droppedDuplicateEdges: 0,
		droppedPersonMerges: 0,
		droppedDuplicateThoughts: 0,
		thrashGuardTriggered: false,
		droppedVagueActionItems: 0,
		addedAssignedToEdges: 0,
	};

	if (diff.no_changes) {
		return { diff, report };
	}

	// Thrash guard — if the model is trying to wipe most of the existing
	// graph in one pass, drop the removes (keep additions / updates / notes).
	let removeNodes = diff.remove_nodes;
	let removeEdges = diff.remove_edges;
	if (
		graph.nodes.length > 4 &&
		removeNodes.length / graph.nodes.length > THRASH_NODE_REMOVAL_FRACTION
	) {
		report.thrashGuardTriggered = true;
		removeNodes = [];
		removeEdges = [];
	}

	// AIZ-33 — auto-fix + drop pass for action_item nodes.
	//
	// Auto-fix (attribution): if the model emits an action_item with a
	// `speaker` field but forgets the `assigned_to` edge, add the edge
	// ourselves. The model frequently does this because the prompt asks
	// it to do two things (set speaker AND add edge) and only one lands.
	//
	// Drop (attribution): action_items must have an `assigned_to` edge
	// to a person — after auto-fix runs.
	//
	// Drop (substance): no owner anchor; fall back to keyword-based
	// meta-commitment detection on label + description.
	const droppedActionIds = new Set<string>();
	const synthesizedAssignedEdges: Edge[] = [];
	if (mode === "attribution") {
		const personIdsForCheck = new Set<string>();
		for (const n of graph.nodes)
			if (n.type === "person") personIdsForCheck.add(n.id);
		for (const n of diff.add_nodes)
			if (n.type === "person") personIdsForCheck.add(n.id);
		// Speakers will be lifted to person nodes later in this pass.
		// Pre-compute their ids so the assigned_to auto-fix can target
		// a person even before the person node is materialized.
		for (const n of [...graph.nodes, ...diff.add_nodes]) {
			if (n.speaker) personIdsForCheck.add(speakerToId(n.speaker));
		}

		const assignedToTargets = new Map<string, string>(); // action_item id → person id
		const recordAssigned = (e: Edge) => {
			if (e.relation === "assigned_to") assignedToTargets.set(e.from, e.to);
		};
		for (const e of graph.edges) recordAssigned(e);
		for (const e of diff.add_edges) recordAssigned(e);

		for (const n of diff.add_nodes) {
			if (n.type !== "action_item") continue;
			let target = assignedToTargets.get(n.id);
			if (!target && n.speaker) {
				const candidate = speakerToId(n.speaker);
				if (personIdsForCheck.has(candidate)) {
					target = candidate;
					assignedToTargets.set(n.id, candidate);
					synthesizedAssignedEdges.push({
						id: `${n.id}-assigned_to-${candidate}`,
						from: n.id,
						to: candidate,
						relation: "assigned_to",
					});
				}
			}
			if (!target || !personIdsForCheck.has(target)) {
				droppedActionIds.add(n.id);
			}
		}
		report.addedAssignedToEdges = synthesizedAssignedEdges.length;
	} else if (mode === "substance") {
		// No owner anchor available — fall back to keyword-based meta-
		// commitment detection on label + description.
		for (const n of diff.add_nodes) {
			if (n.type !== "action_item") continue;
			const haystack = `${n.label}\n${n.description ?? ""}`;
			if (SUBSTANCE_VAGUE_ACTION_PATTERNS.some((re) => re.test(haystack))) {
				droppedActionIds.add(n.id);
			}
		}
	}

	report.droppedVagueActionItems = droppedActionIds.size;

	const filteredAddNodes =
		droppedActionIds.size === 0
			? diff.add_nodes
			: diff.add_nodes.filter((n) => !droppedActionIds.has(n.id));
	const filteredUpdateNodes =
		droppedActionIds.size === 0
			? diff.update_nodes
			: diff.update_nodes.filter((u) => !droppedActionIds.has(u.id));
	const addEdgesAfterActionFilter =
		droppedActionIds.size === 0
			? [...diff.add_edges, ...synthesizedAssignedEdges]
			: [
					...diff.add_edges.filter(
						(e) => !droppedActionIds.has(e.from) && !droppedActionIds.has(e.to),
					),
					...synthesizedAssignedEdges,
				];

	// Dedupe thoughts within a single diff by id (keep the last occurrence).
	const thoughtById = new Map<string, (typeof diff.notes)[number]>();
	for (const t of diff.notes) {
		if (thoughtById.has(t.id)) report.droppedDuplicateThoughts++;
		thoughtById.set(t.id, t);
	}
	const dedupedThoughts = [...thoughtById.values()];

	// 1. Ensure every referenced speaker has a person node.
	const personIds = new Set<string>();
	for (const n of graph.nodes) if (n.type === "person") personIds.add(n.id);
	for (const n of filteredAddNodes)
		if (n.type === "person") personIds.add(n.id);

	// Refuse merges that would absorb a person into another person — different
	// people are never duplicates of each other.
	const filteredMerges = diff.merge_nodes.filter((m) => {
		const keepIsPerson = personIds.has(m.keep);
		const absorbHasPerson = m.absorb.some((id) => personIds.has(id));
		if (keepIsPerson && absorbHasPerson) {
			report.droppedPersonMerges++;
			return false;
		}
		return true;
	});

	const speakers = new Set<string>();
	for (const n of [...graph.nodes, ...filteredAddNodes]) {
		if (n.speaker) speakers.add(n.speaker);
	}

	const addedPersonNodes: Node[] = [];
	for (const speaker of speakers) {
		const id = speakerToId(speaker);
		if (!personIds.has(id)) {
			addedPersonNodes.push({ id, label: speaker, type: "person" });
			personIds.add(id);
			report.addedPersonNodes.push(id);
		}
	}

	// 2 & 3. Filter add_edges with the post-merge picture in mind.
	const relationsByPair = new Map<string, Set<EdgeRelation>>();
	const recordPair = (e: Edge) => {
		const key = pairKey(e.from, e.to);
		let set = relationsByPair.get(key);
		if (!set) {
			set = new Set();
			relationsByPair.set(key, set);
		}
		set.add(e.relation);
	};
	for (const e of graph.edges) recordPair(e);
	for (const e of addEdgesAfterActionFilter) recordPair(e);

	const personOwnsTarget = (from: string, to: string): boolean => {
		const has = (edges: Edge[]) =>
			edges.some(
				(e) => e.from === from && e.to === to && e.relation === "owns",
			);
		return has(graph.edges) || has(addEdgesAfterActionFilter);
	};

	const filteredEdges: Edge[] = [];
	const tripleKey = (e: Edge) => `${e.from}|${e.to}|${e.relation}`;
	const existingTriples = new Set<string>(graph.edges.map(tripleKey));
	const seenInDiff = new Set<string>();
	for (const e of addEdgesAfterActionFilter) {
		if (e.from === e.to) {
			report.droppedSelfLoops++;
			continue;
		}
		const triple = tripleKey(e);
		if (existingTriples.has(triple) || seenInDiff.has(triple)) {
			report.droppedDuplicateEdges++;
			continue;
		}
		if (e.relation === "related_to") {
			const relations = relationsByPair.get(pairKey(e.from, e.to));
			const hasSpecific =
				relations && [...relations].some((r) => SPECIFIC_RELATIONS.has(r));
			if (hasSpecific) {
				report.droppedRedundantRelatedTo++;
				continue;
			}
		}
		if (e.relation === "mentions" && personOwnsTarget(e.from, e.to)) {
			report.droppedTrivialMentions++;
			continue;
		}
		seenInDiff.add(triple);
		filteredEdges.push(e);
	}

	return {
		diff: {
			...diff,
			add_nodes: [...filteredAddNodes, ...addedPersonNodes],
			add_edges: filteredEdges,
			update_nodes: filteredUpdateNodes,
			merge_nodes: filteredMerges,
			remove_nodes: removeNodes,
			remove_edges: removeEdges,
			notes: dedupedThoughts,
		},
		report,
	};
}
