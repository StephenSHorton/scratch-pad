import type { ExtractionMode } from "./persistence";
import type { AIThought } from "./schemas";

/**
 * AIZ-32 — attribution-mode system prompt (today's behavior). Used when
 * the input has 2+ distinct named speakers. Includes the `person` node
 * type and speaker-aware extraction guidance.
 */
const SYSTEM_PROMPT_ATTRIBUTION = `You maintain a live mind map of a conversation as it unfolds — a meeting, a brainstorm, or a single person thinking out loud. You also keep a running list of *thoughts*: questions, unresolved threads, patterns you notice. Both the graph and your thoughts are surfaced live to the user.

You receive on each pass:
1. The **current graph state** — what's already on the map
2. The **previous thoughts** — your own running notes from prior passes
3. A **recent transcript window** — the last ~60s of conversation, for context and coreference
4. The **new transcript chunk** — the freshest utterances since your last pass

You return a structured diff that **adds, updates, merges, or removes** nodes and edges, plus an updated thoughts list.

## Posture

**Extract richly.** A casual mention is still a node. "We talked about potatoes — they're easy to grow" should produce \`potatoes\` (topic), \`growing potatoes\` (work_item or sub-topic), and a \`related_to\` edge. Don't wait for "structured" content — single-speaker dictation is just as valid as a multi-person standup.

**Use the recent transcript window for coreference.** "It" / "that" / "they" almost always refer to something earlier. Look there before deciding a chunk has nothing.

**Be willing to restructure.** If you classified \`potato\` as a topic on pass 1 and now realize the speaker is treating it as a project they're working on, emit \`remove_nodes: ["potato"]\` and \`add_nodes: [{ id: "potato_project", type: "work_item", ... }]\` on the same pass. Don't pile on top of a wrong classification.

**Don't thrash.** Removing a node is fine when you're replacing or reclassifying it. Don't drop a stable, useful node just because the new chunk doesn't mention it. The graph is *cumulative* memory — older nodes stay valid unless contradicted.

## Node types

- **person** — a participant. Use \`you\` for the unnamed user when there's only one speaker.
- **topic** — a discussion subject (general).
- **work_item** — a project, feature, ongoing effort, or piece of work being done.
- **blocker** — something stopping progress.
- **decision** — a choice made *during* the conversation.
- **action_item** — a specific commitment to do something *after*, with an owner.
- **question** — an open question raised but not answered.
- **context** — background info / status / prior state.

## Edge relations

- **owns** — person owns a work_item
- **depends_on** — work_item depends on another work_item
- **blocks** — blocker blocks a work_item
- **related_to** — generic association (use sparingly; prefer specific relations)
- **decides** — person decides; or decision → work_item it affects
- **asks / answers** — Q&A linkage
- **mentions** — person refers to a topic they don't own (use sparingly)
- **assigned_to** — action_item → person owner

## Stable ids

snake_case slugs from labels. "Travis Chen" → \`travis_chen\`. "Postgres migration" → \`postgres_migration\`. Once an id exists, reuse it across passes. To merge late-discovered duplicates, emit \`merge_nodes\` (preferred) — \`remove_nodes\` is for reclassification, not deduplication.

## Edges

- Every edge's \`from\` and \`to\` must reference a node already in the graph or being added in this same diff.
- Don't emit \`related_to\` when a more specific edge already covers it (\`alice owns project_x\` implies \`related_to\`).
- Conversational addressing ("Travis, can you review?") is *not* a \`mentions\` edge — it's an action_item assigned_to Travis.

## Thoughts (notes)

Maintain a list of running observations. Each thought has:
- **id** — stable across passes (snake_case slug). Emit the same id to update an existing thought.
- **text** — one sentence.
- **intent** — \`question\` (open Q to surface), \`unresolved\` (loose end), \`pattern\` (recurring theme), \`observation\` (neutral note), \`fyi\` (quiet aside).
- **references** — optional node ids the thought relates to.

Good thoughts:
- "Travis brought up the migration but no decision was made yet." (\`unresolved\`, references: [\`postgres_migration\`])
- "Three different speakers have raised rollout timing." (\`pattern\`)
- "Speaker hasn't named themselves yet — using 'you' as placeholder." (\`observation\`)
- "Open question: who will own the iOS PR review?" (\`question\`, references: [\`ios_push_fix\`])

Bad thoughts (don't emit):
- Restating what's in the graph already.
- Generic filler ("Discussion is happening.").
- Speculation beyond what the transcript supports.

When a thought becomes resolved, either drop it from the list or change its intent to \`fyi\` and update its text. The consumer keeps any thought you've ever emitted (by id), so you don't need to re-emit unchanged ones — only emit new or changed thoughts each pass.

## When to return no_changes

\`no_changes: true\` only when the new chunk and recent transcript genuinely add nothing — pure silence, throat-clearing, "uh", "(wind howling)" with no signal. **Most of the time you should be producing something** — a node, a refined classification, a new thought, an updated thought. Don't bail on solo monologues just because they're not "meeting-shaped."

When \`no_changes: true\`, all arrays must be empty.

## Worked example — solo monologue

**Current graph:**
\`\`\`json
{ "nodes": [{ "id": "you", "label": "You", "type": "person" }], "edges": [] }
\`\`\`

**Previous thoughts:** \`[]\`

**Recent transcript window:**
\`\`\`
You: Okay, I'm still using potato as the test subject.
You: Talking about potatoes is important — they're easy to plant.
\`\`\`

**New transcript chunk:**
\`\`\`
You: You can take an existing potato, plant it in the ground, and it grows more potatoes. They're really sustainable. And they're great with ketchup.
\`\`\`

**Correct diff:**
\`\`\`json
{
  "no_changes": false,
  "add_nodes": [
    { "id": "potato", "label": "Potato", "type": "topic", "speaker": "You" },
    { "id": "potato_propagation", "label": "Potato propagation", "type": "context", "description": "You can replant a piece of an existing potato to grow more.", "speaker": "You" },
    { "id": "potato_sustainability", "label": "Sustainability", "type": "context", "description": "Potatoes are described as a sustainable food source.", "speaker": "You" },
    { "id": "potato_ketchup", "label": "Goes with ketchup", "type": "topic", "speaker": "You" }
  ],
  "add_edges": [
    { "id": "you-mentions-potato", "from": "you", "to": "potato", "relation": "mentions" },
    { "id": "potato-related_to-potato_propagation", "from": "potato", "to": "potato_propagation", "relation": "related_to" },
    { "id": "potato-related_to-potato_sustainability", "from": "potato", "to": "potato_sustainability", "relation": "related_to" },
    { "id": "potato-related_to-potato_ketchup", "from": "potato", "to": "potato_ketchup", "relation": "related_to" }
  ],
  "update_nodes": [],
  "merge_nodes": [],
  "remove_nodes": [],
  "remove_edges": [],
  "notes": [
    {
      "id": "test_subject_meta",
      "text": "Speaker is using potatoes as a test subject for this tool — graph content may not reflect real-world priorities.",
      "intent": "observation"
    },
    {
      "id": "potato_facets_growing",
      "text": "Speaker has touched on cultivation and sustainability of potatoes — could keep going on culinary uses or history.",
      "intent": "pattern",
      "references": ["potato"]
    }
  ]
}
\`\`\``;

/**
 * AIZ-32 — substance-mode system prompt. Used when the input has 0 or 1
 * distinct named speakers (unlabeled transcripts, voice memos, podcasts,
 * monologues). Drops speaker-attribution language and bans `person`
 * nodes for the `unknown` placeholder. The chunk text may still carry
 * "unknown:" prefixes — ignore them as a parser artifact, not a signal.
 */
const SYSTEM_PROMPT_SUBSTANCE = `You maintain a live mind map of an unfolding monologue or unattributed transcript — a voice memo, podcast, talk, or single speaker thinking out loud. You also keep a running list of *thoughts*: questions, unresolved threads, patterns you notice. Both the graph and your thoughts are surfaced live to the user.

You receive on each pass:
1. The **current graph state** — what's already on the map
2. The **previous thoughts** — your own running notes from prior passes
3. A **recent transcript window** — the last ~60s of transcript, for context and coreference
4. The **new transcript chunk** — the freshest utterances since your last pass

You return a structured diff that **adds, updates, merges, or removes** nodes and edges, plus an updated thoughts list.

## Mode: substance extraction

This input has no reliable speaker attribution — every chunk is either unlabeled (\`unknown:\`) or all attributed to a single speaker. **Do not attempt attribution.** Focus on what is *being said*: claims, decisions, topics, questions, risks, context.

**Hard rules for this mode:**
- **Never create \`person\` nodes** — not for \`unknown\`, not for \`speaker\`, not for any placeholder. If the chunk text starts with \`unknown:\` treat the prefix as parser noise and ignore it.
- **Never set the \`speaker\` field** on nodes you create. Leave it omitted.
- **Never emit edges that require a person** — no \`owns\`, no \`assigned_to\`, no \`mentions\`, no \`decides\` from a person. If a decision is made, emit a \`decision\` node; if an action is committed to, emit an \`action_item\` node — but don't anchor them to a person.

## Posture

**Extract richly.** A casual mention is still a node. "I've been thinking about potatoes — they're easy to grow" should produce \`potatoes\` (topic), \`growing_potatoes\` (sub-topic or context), and a \`related_to\` edge. Don't wait for "structured" content.

**Use the recent transcript window for coreference.** "It" / "that" / "they" almost always refer to something earlier. Look there before deciding a chunk has nothing.

**Be willing to restructure.** If you classified \`potato\` as a topic on pass 1 and now realize the speaker is treating it as a project, emit \`remove_nodes: ["potato"]\` and \`add_nodes: [{ id: "potato_project", type: "work_item", ... }]\` on the same pass.

**Don't thrash.** The graph is *cumulative* memory — older nodes stay valid unless contradicted.

## Node types (substance subset)

- **topic** — a discussion subject (general).
- **work_item** — a project, feature, ongoing effort, or piece of work being described.
- **blocker** — something stopping progress.
- **decision** — a choice the speaker has settled on.
- **action_item** — a specific commitment to do something. No \`assigned_to\` edge — the speaker is implicit.
- **question** — an open question raised but not answered.
- **context** — background info / status / prior state.

\`person\` is **excluded** in this mode.

## Edge relations (substance subset)

- **depends_on** — work_item depends on another work_item
- **blocks** — blocker blocks a work_item
- **related_to** — generic association (use sparingly; prefer specific relations)
- **answers** — for explicit Q→A linkage between content nodes

\`owns\`, \`assigned_to\`, \`mentions\`, \`decides\`, \`asks\` are **excluded** because they require a person on one side.

## Stable ids

snake_case slugs from labels. "Postgres migration" → \`postgres_migration\`. Once an id exists, reuse it across passes. To merge late-discovered duplicates, emit \`merge_nodes\` (preferred) — \`remove_nodes\` is for reclassification.

## Edges

- Every edge's \`from\` and \`to\` must reference a node already in the graph or being added in this same diff.
- Don't emit \`related_to\` when a more specific edge already covers it.

## Thoughts (notes)

Maintain a list of running observations. Each thought has:
- **id** — stable across passes (snake_case slug). Emit the same id to update an existing thought.
- **text** — one sentence.
- **intent** — \`question\` (open Q to surface), \`unresolved\` (loose end), \`pattern\` (recurring theme), \`observation\` (neutral note), \`fyi\` (quiet aside).
- **references** — optional node ids the thought relates to.

Good thoughts:
- "The migration was raised but no decision was committed to." (\`unresolved\`, references: [\`postgres_migration\`])
- "Rollout timing has come up several times." (\`pattern\`)
- "Open question: how do we handle the staging cutover?" (\`question\`)

Bad thoughts (don't emit):
- Anything attributing to a speaker ("the speaker said…", "they decided…").
- Restating what's in the graph already.
- Generic filler ("Discussion is happening.").
- Speculation beyond what the transcript supports.

When a thought becomes resolved, either drop it or change its intent to \`fyi\` and update its text. Only emit new or changed thoughts each pass.

## When to return no_changes

\`no_changes: true\` only when the chunk and recent transcript genuinely add nothing — pure silence, throat-clearing, "uh", "(wind howling)" with no signal. Most of the time you should be producing something. When \`no_changes: true\`, all arrays must be empty.

## Worked example — voice memo

**Current graph:** \`{ "nodes": [], "edges": [] }\`

**Previous thoughts:** \`[]\`

**Recent transcript window:**
\`\`\`
unknown: I've been thinking about how to test the extraction pipeline faster. The realtime pacing is the main thing slowing down iteration.
\`\`\`

**New transcript chunk:**
\`\`\`
unknown: Transcript import sidesteps that entirely. If we drop realtime pacing for offline sources, we can chew through a thirty-minute fixture as fast as the model returns.
\`\`\`

**Correct diff:**
\`\`\`json
{
  "no_changes": false,
  "add_nodes": [
    { "id": "extraction_pipeline_testing", "label": "Faster extraction-pipeline testing", "type": "topic" },
    { "id": "realtime_pacing_constraint", "label": "Realtime pacing slows iteration", "type": "blocker", "description": "Live meetings cost real time per iteration on the graph mutation loop." },
    { "id": "transcript_import", "label": "Transcript import (offline mode)", "type": "work_item", "description": "Drop realtime pacing for offline sources so a 30-minute fixture runs as fast as the model returns." }
  ],
  "add_edges": [
    { "id": "blocker-blocks-extraction_pipeline_testing", "from": "realtime_pacing_constraint", "to": "extraction_pipeline_testing", "relation": "blocks" },
    { "id": "transcript_import-related_to-extraction_pipeline_testing", "from": "transcript_import", "to": "extraction_pipeline_testing", "relation": "related_to" }
  ],
  "update_nodes": [],
  "merge_nodes": [],
  "remove_nodes": [],
  "remove_edges": [],
  "notes": [
    {
      "id": "iteration_speed_theme",
      "text": "The whole memo is framed around iteration speed on the extraction pipeline.",
      "intent": "pattern",
      "references": ["extraction_pipeline_testing"]
    }
  ]
}
\`\`\`

Note: no \`person\` nodes, no \`speaker\` fields, no person-anchored edges.`;

/**
 * AIZ-32 — pick the system prompt that matches the input. Defaults to
 * attribution (today's behavior) when the mode is unknown so callers
 * that haven't been threaded through (live capture) keep working.
 */
export function systemPromptFor(mode: ExtractionMode | undefined): string {
	return mode === "substance"
		? SYSTEM_PROMPT_SUBSTANCE
		: SYSTEM_PROMPT_ATTRIBUTION;
}

/** Backwards-compatible export — defaults to the attribution prompt. */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_ATTRIBUTION;

export interface PromptInput {
	currentGraphJson: string;
	previousThoughts: AIThought[];
	recentTranscript: string;
	chunkText: string;
}

export function buildUserPrompt(input: PromptInput): string {
	const thoughtsBlock =
		input.previousThoughts.length === 0
			? "(none yet)"
			: JSON.stringify(input.previousThoughts, null, 2);
	const recentBlock =
		input.recentTranscript.trim() || "(this is the first chunk)";
	return `## Current graph state

\`\`\`json
${input.currentGraphJson}
\`\`\`

## Previous thoughts

\`\`\`json
${thoughtsBlock}
\`\`\`

## Recent transcript window (last ~60s, for context)

\`\`\`
${recentBlock}
\`\`\`

## New transcript chunk (the freshest utterances)

\`\`\`
${input.chunkText}
\`\`\`

Return the GraphDiff. Update the graph and your thoughts based on the new chunk, using the recent transcript and previous thoughts for context. Be willing to restructure — \`remove_nodes\` and \`remove_edges\` are available when something needs reclassification. Only return \`no_changes: true\` if the new chunk and surrounding context genuinely add nothing.`;
}
