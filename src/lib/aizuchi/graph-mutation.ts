import { generateObject } from "ai";
import { type NormalizeReport, normalizeDiff } from "./normalize";
import type { ExtractionMode } from "./persistence";
import {
	buildFinalizeUserPrompt,
	buildUserPrompt,
	FINALIZE_SYSTEM_PROMPT,
	systemPromptFor,
} from "./prompts";
import { getProvider, type ProviderName } from "./providers";
import {
	type AIThought,
	type Graph,
	type GraphDiff,
	GraphDiff as GraphDiffSchema,
	type TranscriptChunk,
} from "./schemas";

export interface MutateOptions {
	provider?: ProviderName;
	previousThoughts?: AIThought[];
	recentTranscript?: string;
	/** AIZ-32 — picks the prompt template. Defaults to `attribution`. */
	extractionMode?: ExtractionMode;
}

export interface MutateResult {
	diff: GraphDiff;
	rawDiff: GraphDiff;
	normalize: NormalizeReport;
	providerLabel: string;
	latencyMs: number;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}

export async function mutateGraph(
	currentGraph: Graph,
	chunkText: string,
	opts: MutateOptions = {},
): Promise<MutateResult> {
	const provider = getProvider(opts.provider);
	const start = performance.now();

	const result = await generateObject({
		model: provider.model,
		schema: GraphDiffSchema,
		system: systemPromptFor(opts.extractionMode),
		prompt: buildUserPrompt({
			currentGraphJson: JSON.stringify(currentGraph, null, 2),
			previousThoughts: opts.previousThoughts ?? [],
			recentTranscript: opts.recentTranscript ?? "",
			chunkText,
		}),
		temperature: 0.2,
	});

	const latencyMs = performance.now() - start;
	const { diff: normalizedDiff, report } = normalizeDiff(
		currentGraph,
		result.object,
		opts.extractionMode,
	);

	return {
		diff: normalizedDiff,
		rawDiff: result.object,
		normalize: report,
		providerLabel: provider.label,
		latencyMs,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
	};
}

export interface FinalizeOptions {
	provider?: ProviderName;
	previousThoughts?: AIThought[];
	/**
	 * AIZ-32 — drives mode-aware normalization (`person` rules etc.).
	 * The finalize prompt itself stays mode-agnostic and infers from the
	 * presence of `person` nodes in the input graph.
	 */
	extractionMode?: ExtractionMode;
}

/**
 * AIZ-49 — single end-of-transcript review pass. Same wire shape as
 * `mutateGraph` so the caller can apply the diff via the existing
 * `applyDiff` path. Differs in three ways:
 *
 *   1. uses `FINALIZE_SYSTEM_PROMPT` instead of the streaming prompt
 *   2. takes the *full* transcript instead of a batch + recent window
 *   3. has no concept of "next batch" — caller fires it once and moves on
 *
 * The full-transcript-as-string is built by joining `speaker: text` lines
 * the same way `recentTranscriptText` does in the hook.
 */
export async function finalizeGraph(
	currentGraph: Graph,
	transcript: TranscriptChunk[],
	opts: FinalizeOptions = {},
): Promise<MutateResult> {
	const provider = getProvider(opts.provider);
	const start = performance.now();

	const fullTranscript = transcript
		.map((c) => `${c.speaker}: ${c.text}`)
		.join("\n");

	const result = await generateObject({
		model: provider.model,
		schema: GraphDiffSchema,
		system: FINALIZE_SYSTEM_PROMPT,
		prompt: buildFinalizeUserPrompt({
			currentGraphJson: JSON.stringify(currentGraph, null, 2),
			previousThoughts: opts.previousThoughts ?? [],
			fullTranscript,
		}),
		temperature: 0.2,
	});

	const latencyMs = performance.now() - start;
	const { diff: normalizedDiff, report } = normalizeDiff(
		currentGraph,
		result.object,
		opts.extractionMode,
	);

	return {
		diff: normalizedDiff,
		rawDiff: result.object,
		normalize: report,
		providerLabel: provider.label,
		latencyMs,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
	};
}
