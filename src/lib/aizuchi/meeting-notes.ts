import { generateObject } from "ai";
import { z } from "zod";
import { getProvider, type ProviderName } from "./providers";
import type { AIThoughtRecord, Graph, TranscriptChunk } from "./schemas";

const MeetingNotesSchema = z.object({
	title: z
		.string()
		.describe(
			"Short title for the note. Topical when there's a clear focus (e.g. 'Postgres migration sync'), otherwise dated (e.g. 'Aizuchi prototype — 2026-05-01'). Max ~60 chars.",
		),
	body: z
		.string()
		.describe(
			"Markdown body. Section structure is YOUR choice based on what's actually present — don't fabricate empty sections.",
		),
});

export interface MeetingNotesResult {
	title: string;
	body: string;
	latencyMs: number;
	providerLabel: string;
}

export interface MeetingNotesOptions {
	provider?: ProviderName;
	/** Window of the most recent transcript to include verbatim. Defaults to all chunks. */
	transcriptWindowMs?: number;
}

const SYSTEM_PROMPT = `You're a meeting note-taker. Given a structured graph of a conversation, the assistant's running observations, and the recent transcript, produce a markdown summary that someone could paste into their personal notes.

## Posture

**Decide structure from content.** Don't apply a template. A 5-person standup gets sections per person + decisions + action items + blockers. A solo brainstorm gets a topic outline. A short tangential exchange gets a paragraph. An empty graph gets a single line ("No content captured yet.").

**Never fabricate sections that have no content.** If there are no decisions, don't add a "Decisions" section. If there are no action items, no "Action items" section. Empty headings are noise.

**Pull from all three inputs.** The graph gives you who/what/relations. The thoughts surface unresolved questions, patterns, and open threads — these often deserve their own section ("Open questions" or "Unresolved"). The transcript gives you tone and the actual phrasing people used — quote sparingly when it adds something.

**Be terse.** This goes in a sticky note. Bullet points over paragraphs. Skip preamble ("This meeting was about..."). Skip closings ("Overall, a productive session.").

**Don't hallucinate.** If a node has no description and the transcript doesn't elaborate, just name it. Don't invent details to fill space.

## Title

- Topical when there's a clear focus: "Payments migration planning", "Potato propagation brainstorm"
- Dated when it's a generic standup or grab-bag: "Standup — 2026-05-01"
- Avoid "Meeting Notes" / "Summary" — be specific.

## Body sections to consider (use only when content supports them)

- **Attendees** — only if multiple distinct people; skip for solo.
- **Topics** / **Discussion** — the main subjects, as bullets.
- **Decisions** — only if there are decision nodes or clear decisions in the transcript.
- **Action items** — only if there are action_item nodes; format as "- [ ] @owner — task".
- **Blockers** — only if there are blocker nodes or explicit blockers raised.
- **Open questions** / **Unresolved** — pull from thoughts with intent question/unresolved.
- **Notes** — patterns, observations worth keeping.

## Empty graph

If the graph has zero nodes, return a one-line body: "No content captured yet." and a generic dated title. Don't invent a meeting that didn't happen.`;

function recentTranscript(
	transcript: TranscriptChunk[],
	windowMs?: number,
): string {
	if (transcript.length === 0) return "";
	if (!windowMs) {
		return transcript.map((c) => `${c.speaker}: ${c.text}`).join("\n");
	}
	const cutoff = (transcript[transcript.length - 1]?.endMs ?? 0) - windowMs;
	const recent = transcript.filter((c) => c.endMs >= cutoff);
	return recent.map((c) => `${c.speaker}: ${c.text}`).join("\n");
}

function buildPrompt(
	graph: Graph,
	thoughts: AIThoughtRecord[],
	transcriptText: string,
	now: Date,
): string {
	const dateStr = now.toISOString().slice(0, 10);
	const graphJson = JSON.stringify(graph, null, 2);
	const thoughtsJson =
		thoughts.length === 0
			? "(none)"
			: JSON.stringify(
					thoughts.map((t) => ({
						id: t.id,
						text: t.text,
						intent: t.intent,
						references: t.references,
					})),
					null,
					2,
				);
	const transcriptBlock = transcriptText.trim() || "(no transcript captured)";

	return `Today's date: ${dateStr}

## Graph

\`\`\`json
${graphJson}
\`\`\`

## AI thoughts (running observations from the live pass)

\`\`\`json
${thoughtsJson}
\`\`\`

## Transcript

\`\`\`
${transcriptBlock}
\`\`\`

Produce a markdown meeting-notes summary. Decide section structure based on what's actually present in the graph, thoughts, and transcript — don't apply a template. Return { title, body }.`;
}

export async function generateMeetingNotes(
	graph: Graph,
	thoughts: AIThoughtRecord[],
	transcript: TranscriptChunk[],
	opts: MeetingNotesOptions = {},
): Promise<MeetingNotesResult> {
	const provider = getProvider(opts.provider);
	const start = performance.now();

	const transcriptText = recentTranscript(transcript, opts.transcriptWindowMs);

	const result = await generateObject({
		model: provider.model,
		schema: MeetingNotesSchema,
		system: SYSTEM_PROMPT,
		prompt: buildPrompt(graph, thoughts, transcriptText, new Date()),
		temperature: 0.3,
	});

	const latencyMs = performance.now() - start;

	return {
		title: result.object.title,
		body: result.object.body,
		latencyMs,
		providerLabel: provider.label,
	};
}
