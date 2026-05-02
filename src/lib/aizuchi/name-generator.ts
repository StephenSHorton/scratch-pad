import { generateObject } from "ai";
import { z } from "zod";
import { getProvider, type ProviderName } from "./providers";
import type { Graph, TranscriptChunk } from "./schemas";

const MeetingNameSchema = z.object({
	name: z
		.string()
		.describe(
			"A short, specific meeting name — at most ~60 characters. Topical when there's a clear focus (e.g. 'Postgres migration sync', 'Potato propagation brainstorm'). Avoid generic placeholders ('Meeting', 'Discussion', 'Notes') and avoid leading filler ('Meeting about…').",
		),
});

export interface NameProposal {
	name: string;
	latencyMs: number;
	providerLabel: string;
}

export interface NameGeneratorOptions {
	provider?: ProviderName;
	/** Window of the most recent transcript to feed the model. Defaults to 60s. */
	transcriptWindowMs?: number;
	/** Hard cap on how many recent chunks we send. Keeps the prompt small. */
	maxChunks?: number;
}

const DEFAULT_TRANSCRIPT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CHUNKS = 24;

const SYSTEM_PROMPT = `You name meetings. Given a structured graph of the conversation so far and the most recent transcript, return one short, specific name that a participant could read and immediately recognize.

## Rules

- 60 characters max. Shorter is better.
- Specific over generic. "Postgres migration sync" beats "Engineering meeting".
- Use the dominant topic, project, or decision in the graph — don't average over everything.
- No leading filler. "Postgres migration sync" not "Meeting about the Postgres migration".
- Title-case-ish for readability, but don't force it on technical terms ("iOS push fix").
- If the graph is sparse or topic is unclear, prefer a brief topic phrase based on what IS there over a generic "Standup".
- Don't invent details that aren't in the graph or transcript.

Return { name }.`;

function recentTranscriptText(
	transcript: TranscriptChunk[],
	windowMs: number,
	maxChunks: number,
): string {
	if (transcript.length === 0) return "";
	const cutoff = (transcript[transcript.length - 1]?.endMs ?? 0) - windowMs;
	const windowed = transcript.filter((c) => c.endMs >= cutoff);
	const tail = windowed.slice(-maxChunks);
	return tail.map((c) => `${c.speaker}: ${c.text}`).join("\n");
}

function buildPrompt(graph: Graph, transcriptText: string): string {
	const graphJson = JSON.stringify(graph, null, 2);
	const transcriptBlock = transcriptText.trim() || "(no transcript yet)";
	return `## Graph

\`\`\`json
${graphJson}
\`\`\`

## Recent transcript

\`\`\`
${transcriptBlock}
\`\`\`

Return { name } — a short specific meeting name.`;
}

export async function proposeMeetingName(
	graph: Graph,
	transcript: TranscriptChunk[],
	opts: NameGeneratorOptions = {},
): Promise<NameProposal> {
	const provider = getProvider(opts.provider);
	const start = performance.now();
	const transcriptText = recentTranscriptText(
		transcript,
		opts.transcriptWindowMs ?? DEFAULT_TRANSCRIPT_WINDOW_MS,
		opts.maxChunks ?? DEFAULT_MAX_CHUNKS,
	);

	const result = await generateObject({
		model: provider.model,
		schema: MeetingNameSchema,
		system: SYSTEM_PROMPT,
		prompt: buildPrompt(graph, transcriptText),
		temperature: 0.3,
	});

	const latencyMs = performance.now() - start;
	return {
		name: result.object.name.trim(),
		latencyMs,
		providerLabel: provider.label,
	};
}
