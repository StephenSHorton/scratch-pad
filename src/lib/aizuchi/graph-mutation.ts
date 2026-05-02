import { generateObject } from "ai";
import { normalizeDiff, type NormalizeReport } from "./normalize";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import { getProvider, type ProviderName } from "./providers";
import {
	type AIThought,
	type Graph,
	type GraphDiff,
	GraphDiff as GraphDiffSchema,
} from "./schemas";

export interface MutateOptions {
	provider?: ProviderName;
	previousThoughts?: AIThought[];
	recentTranscript?: string;
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
		system: SYSTEM_PROMPT,
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
