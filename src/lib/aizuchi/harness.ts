/**
 * Headless harness — feeds the canned standup transcript through the
 * graph-mutation loop in batched chunks, applies each diff to in-memory state,
 * and prints the evolving map plus the per-batch diff.
 *
 * Run:
 *   bun run src/lib/aizuchi/harness.ts
 *   AIZUCHI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... bun run src/lib/aizuchi/harness.ts
 */

import { batchTranscript, formatChunkBatch } from "./batcher";
import { standupTranscript } from "./fixtures/standup-transcript";
import { mutateGraph } from "./graph-mutation";
import { applyDiff, emptyGraph, type Graph } from "./schemas";

const SIZE_THRESHOLD_WORDS = 60;
const TIME_THRESHOLD_MS = 25_000;

function summarizeGraph(graph: Graph): string {
	if (graph.nodes.length === 0 && graph.edges.length === 0) return "(empty)";
	const lines: string[] = [];
	lines.push(`Nodes (${graph.nodes.length}):`);
	for (const n of graph.nodes) {
		lines.push(
			`  - [${n.type}] ${n.id}: "${n.label}"${n.speaker ? ` (by ${n.speaker})` : ""}`,
		);
	}
	lines.push(`Edges (${graph.edges.length}):`);
	for (const e of graph.edges) {
		lines.push(`  - ${e.from} --[${e.relation}]--> ${e.to}`);
	}
	return lines.join("\n");
}

function summarizeDiff(diff: import("./schemas").GraphDiff): string {
	if (diff.no_changes) return "(no_changes)";
	const parts: string[] = [];
	if (diff.add_nodes.length > 0)
		parts.push(
			`+${diff.add_nodes.length} nodes [${diff.add_nodes.map((n) => n.id).join(", ")}]`,
		);
	if (diff.add_edges.length > 0) parts.push(`+${diff.add_edges.length} edges`);
	if (diff.update_nodes.length > 0)
		parts.push(`~${diff.update_nodes.length} updates`);
	if (diff.merge_nodes.length > 0)
		parts.push(
			`merge: ${diff.merge_nodes.map((m) => `${m.absorb.join("+")}→${m.keep}`).join(", ")}`,
		);
	return parts.length > 0 ? parts.join("  ") : "(empty diff)";
}

async function main() {
	let graph = emptyGraph();
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalLatencyMs = 0;
	let providerLabel = "(unknown)";
	let batchIdx = 0;

	console.log("=".repeat(72));
	console.log("Aizuchi headless harness");
	console.log(`Provider: ${process.env.AIZUCHI_PROVIDER ?? "ollama"}`);
	console.log(`Size threshold: ${SIZE_THRESHOLD_WORDS} words`);
	console.log(`Time threshold: ${TIME_THRESHOLD_MS}ms`);
	console.log("=".repeat(72));

	for (const batch of batchTranscript(
		standupTranscript,
		SIZE_THRESHOLD_WORDS,
		TIME_THRESHOLD_MS,
	)) {
		batchIdx++;
		const chunkText = formatChunkBatch(batch);

		console.log(`\n${"─".repeat(72)}`);
		console.log(
			`BATCH ${batchIdx} — ${batch.wordCount} words, ${batch.chunks.length} utterances`,
		);
		console.log("─".repeat(72));
		console.log(chunkText);

		try {
			const result = await mutateGraph(graph, chunkText);
			providerLabel = result.providerLabel;
			totalLatencyMs += result.latencyMs;
			if (result.usage?.inputTokens)
				totalInputTokens += result.usage.inputTokens;
			if (result.usage?.outputTokens)
				totalOutputTokens += result.usage.outputTokens;

			console.log(
				`\n→ diff: ${summarizeDiff(result.diff)}  (${result.latencyMs.toFixed(0)}ms${
					result.usage?.totalTokens ? `, ${result.usage.totalTokens} tok` : ""
				})`,
			);
			const r = result.normalize;
			if (
				r.addedPersonNodes.length ||
				r.droppedRedundantRelatedTo ||
				r.droppedTrivialMentions ||
				r.droppedSelfLoops ||
				r.droppedDuplicateEdges
			) {
				const fixes: string[] = [];
				if (r.addedPersonNodes.length)
					fixes.push(`+${r.addedPersonNodes.length} person [${r.addedPersonNodes.join(", ")}]`);
				if (r.droppedRedundantRelatedTo)
					fixes.push(`-${r.droppedRedundantRelatedTo} redundant related_to`);
				if (r.droppedTrivialMentions)
					fixes.push(`-${r.droppedTrivialMentions} trivial mentions`);
				if (r.droppedSelfLoops) fixes.push(`-${r.droppedSelfLoops} self-loops`);
				if (r.droppedDuplicateEdges)
					fixes.push(`-${r.droppedDuplicateEdges} duplicate edges`);
				if (r.droppedPersonMerges)
					fixes.push(`-${r.droppedPersonMerges} bad person-person merges`);
				console.log(`  normalize: ${fixes.join(", ")}`);
			}

			graph = applyDiff(graph, result.diff);
			console.log("\nGraph after batch:");
			console.log(summarizeGraph(graph));
		} catch (err) {
			console.error(`\n✗ batch ${batchIdx} failed:`, err);
			break;
		}
	}

	console.log(`\n${"=".repeat(72)}`);
	console.log("Final summary");
	console.log("=".repeat(72));
	console.log(`Provider: ${providerLabel}`);
	console.log(`Batches: ${batchIdx}`);
	console.log(`Total latency: ${(totalLatencyMs / 1000).toFixed(1)}s`);
	if (totalInputTokens || totalOutputTokens) {
		console.log(
			`Total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`,
		);
	}
	console.log(
		`Final graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`,
	);
}

main().catch((err) => {
	console.error("Harness failed:", err);
	process.exit(1);
});
