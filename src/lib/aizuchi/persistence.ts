import { invoke } from "@tauri-apps/api/core";
import type {
	AIThoughtRecord,
	Graph,
	PassRecord,
	TranscriptChunk,
} from "./schemas";

export const SCHEMA_VERSION = 1;

export type MeetingMode = "demo" | "live";

/**
 * AIZ-30/AIZ-31 — origin tag for offline-mode meetings. `undefined`
 * means a live or demo meeting recorded normally; the import paths set
 * this so the browser can show a badge later.
 */
export type MeetingSource = "transcript-import" | "audio-import";

/**
 * AIZ-32 — picks the extraction prompt template. Auto-selected from the
 * staged transcript on the Rust side: 2+ distinct named speakers →
 * `attribution`, otherwise `substance`. Live captures default to
 * `attribution`.
 */
export type ExtractionMode = "attribution" | "substance";

export interface RunStats {
	totalBatches: number;
	totalLatencyMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	providerLabel: string;
}

export interface MeetingSnapshot {
	id: string;
	schemaVersion: typeof SCHEMA_VERSION;
	startedAt: number;
	endedAt: number;
	mode: MeetingMode;
	graph: Graph;
	thoughts: AIThoughtRecord[];
	transcript: TranscriptChunk[];
	passes: PassRecord[];
	stats: RunStats;
	/** AIZ-16: AI-generated or user-overridden meeting name. Optional for backwards compat. */
	name?: string;
	/** AIZ-16: True when the user typed the name. AI re-proposals are skipped while true. */
	nameLockedByUser?: boolean;
	/** AIZ-30/31: present when the meeting was imported rather than captured live. */
	source?: MeetingSource;
	/** AIZ-30/31: original filename for imported meetings. Basename only. */
	sourceFile?: string;
	/** AIZ-32: which prompt template the extraction loop ran against. */
	extractionMode?: ExtractionMode;
}

export interface MeetingMeta {
	id: string;
	startedAt: number;
	endedAt: number;
	mode: string;
	nodeCount: number;
	edgeCount: number;
	thoughtCount: number;
	transcriptDurationMs: number;
	name?: string;
	nameLockedByUser?: boolean;
}

export interface BuildSnapshotInput {
	id?: string;
	mode: MeetingMode;
	startedAt: number;
	graph: Graph;
	thoughts: AIThoughtRecord[];
	transcript: TranscriptChunk[];
	passes: PassRecord[];
	stats: RunStats;
	name?: string;
	nameLockedByUser?: boolean;
	source?: MeetingSource;
	sourceFile?: string;
	extractionMode?: ExtractionMode;
}

function uuid(): string {
	const cryptoObj =
		typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
	if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
		return cryptoObj.randomUUID();
	}
	// Fallback — adequate for prototype, not cryptographic.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newMeetingId(): string {
	return `meeting-${uuid()}`;
}

export function buildSnapshot(input: BuildSnapshotInput): MeetingSnapshot {
	const snap: MeetingSnapshot = {
		id: input.id ?? newMeetingId(),
		schemaVersion: SCHEMA_VERSION,
		startedAt: input.startedAt,
		endedAt: Date.now(),
		mode: input.mode,
		graph: input.graph,
		thoughts: input.thoughts,
		transcript: input.transcript,
		passes: input.passes,
		stats: input.stats,
	};
	if (input.name !== undefined) snap.name = input.name;
	if (input.nameLockedByUser !== undefined)
		snap.nameLockedByUser = input.nameLockedByUser;
	if (input.source !== undefined) snap.source = input.source;
	if (input.sourceFile !== undefined) snap.sourceFile = input.sourceFile;
	if (input.extractionMode !== undefined)
		snap.extractionMode = input.extractionMode;
	return snap;
}

export function saveSnapshot(snapshot: MeetingSnapshot): Promise<string> {
	return invoke<string>("save_meeting", { snapshot });
}

export function listSnapshots(): Promise<MeetingMeta[]> {
	return invoke<MeetingMeta[]>("list_meetings");
}

export function loadSnapshot(id: string): Promise<MeetingSnapshot> {
	return invoke<MeetingSnapshot>("load_meeting", { id });
}

export function deleteSnapshot(id: string): Promise<void> {
	return invoke<void>("delete_meeting", { id });
}

export function openMeetingWindow(id?: string): Promise<void> {
	return invoke<void>("open_meeting", { id: id ?? null });
}
