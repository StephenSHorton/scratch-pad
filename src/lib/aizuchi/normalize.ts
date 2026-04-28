import type { Edge, EdgeRelation, Graph, GraphDiff, Node } from "./schemas";

const SPECIFIC_RELATIONS: ReadonlySet<EdgeRelation> = new Set([
	"owns",
	"depends_on",
	"blocks",
	"decides",
	"assigned_to",
	"answers",
]);

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
}

export interface NormalizeResult {
	diff: GraphDiff;
	report: NormalizeReport;
}

/**
 * Post-process a model-produced diff to handle structural correctness the
 * prompt can't reliably enforce:
 *
 *   1. Auto-create person nodes for any 'speaker' field reference that
 *      lacks a corresponding person node (model frequently forgets this).
 *   2. Drop 'related_to' edges when a more specific edge (owns, depends_on,
 *      blocks, decides, assigned_to, answers) already covers the same pair.
 *   3. Drop 'mentions' edges from a person to a target the same person owns.
 */
export function normalizeDiff(graph: Graph, diff: GraphDiff): NormalizeResult {
	const report: NormalizeReport = {
		addedPersonNodes: [],
		droppedRedundantRelatedTo: 0,
		droppedTrivialMentions: 0,
		droppedSelfLoops: 0,
		droppedDuplicateEdges: 0,
		droppedPersonMerges: 0,
	};

	if (diff.no_changes) {
		return { diff, report };
	}

	// 1. Ensure every referenced speaker has a person node.
	const personIds = new Set<string>();
	for (const n of graph.nodes) if (n.type === "person") personIds.add(n.id);
	for (const n of diff.add_nodes) if (n.type === "person") personIds.add(n.id);

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
	for (const n of [...graph.nodes, ...diff.add_nodes]) {
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
	for (const e of diff.add_edges) recordPair(e);

	const personOwnsTarget = (from: string, to: string): boolean => {
		const has = (edges: Edge[]) =>
			edges.some((e) => e.from === from && e.to === to && e.relation === "owns");
		return has(graph.edges) || has(diff.add_edges);
	};

	const filteredEdges: Edge[] = [];
	const tripleKey = (e: Edge) => `${e.from}|${e.to}|${e.relation}`;
	const existingTriples = new Set<string>(graph.edges.map(tripleKey));
	const seenInDiff = new Set<string>();
	for (const e of diff.add_edges) {
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
			add_nodes: [...diff.add_nodes, ...addedPersonNodes],
			add_edges: filteredEdges,
			merge_nodes: filteredMerges,
		},
		report,
	};
}
