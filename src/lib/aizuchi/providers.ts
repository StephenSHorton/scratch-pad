import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

export type ProviderName = "ollama" | "anthropic";

export interface ProviderConfig {
	name: ProviderName;
	model: LanguageModel;
	label: string;
}

// Reads env from Vite's `import.meta.env` (browser, with VITE_ prefix) or
// `process.env` (Bun/Node harness, no prefix). Vite static-replaces
// `import.meta.env.VITE_*` at build time when defined.
function readEnv(name: string): string | undefined {
	try {
		const viteEnv = (import.meta as { env?: Record<string, string | undefined> })
			.env;
		if (viteEnv) {
			const v = viteEnv[`VITE_${name}`];
			if (v !== undefined && v !== "") return v;
		}
	} catch {
		// import.meta.env not available — fall through to process.env
	}
	const proc = (
		globalThis as {
			process?: { env?: Record<string, string | undefined> };
		}
	).process;
	return proc?.env?.[name];
}

export function getProvider(name?: ProviderName): ProviderConfig {
	const resolved: ProviderName =
		name ?? (readEnv("AIZUCHI_PROVIDER") as ProviderName | undefined) ?? "ollama";

	switch (resolved) {
		case "ollama": {
			const modelName = readEnv("AIZUCHI_OLLAMA_MODEL") ?? "gemma4:latest";
			const ollama = createOllama({
				baseURL: readEnv("OLLAMA_BASE_URL") ?? "http://localhost:11434/api",
			});
			return {
				name: "ollama",
				model: ollama(modelName),
				label: `ollama/${modelName}`,
			};
		}
		case "anthropic": {
			const apiKey = readEnv("ANTHROPIC_API_KEY");
			if (!apiKey) {
				throw new Error(
					"ANTHROPIC_API_KEY is required for the Anthropic provider. Set it in your env or use AIZUCHI_PROVIDER=ollama.",
				);
			}
			const modelName = readEnv("AIZUCHI_ANTHROPIC_MODEL") ?? "claude-haiku-4-5";
			const anthropic = createAnthropic({ apiKey });
			return {
				name: "anthropic",
				model: anthropic(modelName),
				label: `anthropic/${modelName}`,
			};
		}
	}
}
