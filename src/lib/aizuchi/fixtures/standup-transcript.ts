import type { TranscriptChunk } from "../schemas";

export const standupTranscript: TranscriptChunk[] = [
	{
		speaker: "Tim",
		text: "Morning everyone. Quick standup. Let's go around — Travis you're up first.",
		startMs: 0,
		endMs: 4500,
	},
	{
		speaker: "Travis",
		text: "Hey. Yesterday I shipped the auth refactor for the payments service. Today I'm starting on the Postgres migration — splitting the orders table.",
		startMs: 5000,
		endMs: 14000,
	},
	{
		speaker: "Travis",
		text: "Heads up, the migration is going to touch the same orders.line_items table that Priya is using for the new reporting endpoint. We should probably sync up after standup.",
		startMs: 14500,
		endMs: 23000,
	},
	{
		speaker: "Priya",
		text: "Yeah, good catch. I was about to start the line_items aggregation today. Let's pair on it at 10.",
		startMs: 23500,
		endMs: 30000,
	},
	{
		speaker: "Priya",
		text: "Otherwise, yesterday I finished the cohort report. Today is the line_items aggregation, then if there's time I'll start on the dashboard wiring.",
		startMs: 30500,
		endMs: 40000,
	},
	{
		speaker: "Priya",
		text: "Blocker: the staging Redshift cluster is throwing connection timeouts. Already pinged platform but they haven't responded.",
		startMs: 40500,
		endMs: 49000,
	},
	{
		speaker: "Tim",
		text: "I'll escalate the Redshift thing to Marco after standup. Marco's on platform this week.",
		startMs: 49500,
		endMs: 56000,
	},
	{
		speaker: "Sam",
		text: "Hi. Yesterday I was deep on the iOS push notification fix — turns out the cert renewal expired silently last Friday. PR is up, needs review.",
		startMs: 57000,
		endMs: 67000,
	},
	{
		speaker: "Sam",
		text: "Today is Android parity for that fix. No blockers.",
		startMs: 67500,
		endMs: 71000,
	},
	{
		speaker: "Tim",
		text: "Travis can you review Sam's iOS PR before lunch? Sam tag him.",
		startMs: 71500,
		endMs: 76000,
	},
	{
		speaker: "Travis",
		text: "Yeah, will do. I'll get to it after the migration kickoff.",
		startMs: 76500,
		endMs: 80000,
	},
	{
		speaker: "Tim",
		text: "Last thing — we need to decide on the rollout plan for the orders split. Travis, are we doing dual-write or shadow read first?",
		startMs: 80500,
		endMs: 88000,
	},
	{
		speaker: "Travis",
		text: "Shadow read. Less risk. We confirm parity for a week, then cut over.",
		startMs: 88500,
		endMs: 93000,
	},
	{
		speaker: "Tim",
		text: "Okay, decision made. Shadow read first, dual-write off the table for now. Travis owns the rollout plan doc, due Thursday.",
		startMs: 93500,
		endMs: 102000,
	},
	{
		speaker: "Tim",
		text: "Anything else? No? Cool, ship it.",
		startMs: 102500,
		endMs: 105000,
	},
];
