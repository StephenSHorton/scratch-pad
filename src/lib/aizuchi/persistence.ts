import { invoke } from "@tauri-apps/api/core";
import type {
	AIThoughtRecord,
	Graph,
	PassRecord,
	TranscriptChunk,
} from "./schemas";

export const SCHEMA_VERSION = 1;

export type MeetingMode = "demo" | "live";

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
	return {
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
