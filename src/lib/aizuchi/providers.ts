import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

export type ProviderName = "ollama" | "anthropic";

export interface ProviderConfig {
	name: ProviderName;
	model: LanguageModel;
	label: string;
}

const ollama = createOllama({
	baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/api",
});

export function getProvider(name?: ProviderName): ProviderConfig {
	const resolved: ProviderName =
		name ??
		(process.env.AIZUCHI_PROVIDER as ProviderName | undefined) ??
		"ollama";

	switch (resolved) {
		case "ollama": {
			const modelName = process.env.AIZUCHI_OLLAMA_MODEL ?? "gemma4:latest";
			return {
				name: "ollama",
				model: ollama(modelName),
				label: `ollama/${modelName}`,
			};
		}
		case "anthropic": {
			if (!process.env.ANTHROPIC_API_KEY) {
				throw new Error(
					"ANTHROPIC_API_KEY is required for the Anthropic provider. Set it in your env or use AIZUCHI_PROVIDER=ollama.",
				);
			}
			const modelName =
				process.env.AIZUCHI_ANTHROPIC_MODEL ?? "claude-haiku-4-5";
			return {
				name: "anthropic",
				model: anthropic(modelName),
				label: `anthropic/${modelName}`,
			};
		}
	}
}
