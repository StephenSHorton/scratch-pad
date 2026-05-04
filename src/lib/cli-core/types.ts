/**
 * Wire-format type aliases for the v1 IPC contract.
 *
 * These mirror the Rust `serde(rename_all = "camelCase")` shapes in:
 *   - `src-tauri/src/lib.rs` (Note, Position, Size)
 *   - `src-tauri/src/meetings.rs` (MeetingMeta)
 *   - `src-tauri/src/cli_server/handlers/*` (request bodies, list envelopes)
 *
 * `MeetingSnapshot` is re-exported from the existing frontend module so
 * the CLI client and React app share one source of truth.
 */

export type {
	MeetingMeta,
	MeetingMode,
	MeetingSnapshot,
	RunStats,
} from "@/lib/aizuchi/persistence";

/** Sticky note color palette (matches the React app's NOTE_COLORS). */
export type NoteColor = "yellow" | "pink" | "blue" | "green";

export interface Position {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

/**
 * Wire shape for a sticky note (pad). Matches the Rust `Note` struct.
 *
 * The server sets `hidden: false` and `color: "yellow"` as defaults,
 * but `position` / `size` may genuinely be missing — callers should
 * treat them as optional.
 */
export interface Note {
	id: string;
	title?: string | null;
	body: string;
	color: string;
	createdAt: string;
	expiresAt?: string | null;
	position?: Position | null;
	size?: Size | null;
	hidden: boolean;
	hiddenAt?: string | null;
}

// ---------- Status ----------

export interface AppStatus {
	ok: true;
	app: { version: string; name: string };
	ipc: { version: number; startedAt: number };
}

// ---------- Pads ----------

export interface ListPadsOptions {
	include?: "hidden";
	only?: "hidden";
}

export interface CreatePadInput {
	title?: string;
	body: string;
	color?: NoteColor | string;
	width?: number;
	height?: number;
	ttlHours?: number;
	scope?: string;
	intent?: string;
}

export interface PadPatch {
	title?: string;
	body?: string;
	color?: NoteColor | string;
	position?: Position;
	size?: Size;
}

// ---------- Meetings ----------

export interface RenameMeetingInput {
	name?: string;
	nameLockedByUser?: boolean;
}

export interface StartMeetingResponse {
	id: string;
	openedWindow: boolean;
}

export interface ResumeMeetingResponse {
	ok: true;
	windowOpened: boolean;
}

export interface ImportMeetingInput {
	/** Raw transcript content. CLI reads the file off disk; web flows can post in-memory text. */
	content: string;
	/** Original filename. Used for extension dispatch and stored as the snapshot's sourceFile. */
	filename: string;
}

export interface ImportMeetingResponse {
	id: string;
	openedWindow: boolean;
	chunkCount: number;
	sourceFile: string;
}

// ---------- Discovery ----------

export interface IpcConfig {
	baseUrl: string;
	token: string;
}
