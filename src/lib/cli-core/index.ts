/**
 * Public barrel for the Scratch Pad IPC core client.
 *
 * Consumers (the base CLI in `bin/`, the extended CLI in AIZ-22, the
 * MCP refactor in AIZ-23, and any future TS tooling) should import
 * from `@/lib/cli-core` only — never reach into individual modules.
 */

export type { ScratchPadClientOptions } from "./client";
export { ScratchPadClient } from "./client";
export { defaultBaseDir, loadIpcConfig } from "./discovery";
export {
	AppNotRunningError,
	AuthError,
	ConflictError,
	errorFromServer,
	IpcClientError,
	NotFoundError,
	TokenPermsError,
	ValidationError,
} from "./errors";
export type {
	AppStatus,
	CreatePadInput,
	IpcConfig,
	ListPadsOptions,
	MeetingMeta,
	MeetingMode,
	MeetingSnapshot,
	Note,
	NoteColor,
	PadPatch,
	Position,
	RenameMeetingInput,
	ResumeMeetingResponse,
	RunStats,
	Size,
	StartMeetingResponse,
} from "./types";

/** Convenience factory — equivalent to `ScratchPadClient.create(opts)`. */
import { ScratchPadClient, type ScratchPadClientOptions } from "./client";
export function createClient(
	opts?: ScratchPadClientOptions,
): Promise<ScratchPadClient> {
	return ScratchPadClient.create(opts);
}
