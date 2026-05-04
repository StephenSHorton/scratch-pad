/**
 * Typed TS client for the Aizuchi IPC server (v1 contract).
 *
 * Mirrors every endpoint declared in
 * `src-tauri/src/cli_server/routes.rs` 1:1. Server error codes are
 * translated to typed error classes (`errors.ts`) so callers can
 * `catch (e) { if (e instanceof NotFoundError) ... }` without parsing
 * envelope JSON themselves.
 *
 * Usage:
 *   const client = await AizuchiClient.create();
 *   const status = await client.status();
 */

import { loadIpcConfig } from "./discovery";
import { AppNotRunningError, errorFromServer, IpcClientError } from "./errors";
import type {
	AppStatus,
	CreatePadInput,
	ImportMeetingInput,
	ImportMeetingResponse,
	IpcConfig,
	ListPadsOptions,
	MeetingMeta,
	MeetingMode,
	MeetingSnapshot,
	Note,
	PadPatch,
	RenameMeetingInput,
	ResumeMeetingResponse,
	StartMeetingResponse,
} from "./types";

/** Optional knobs for `AizuchiClient.create()`. */
export interface AizuchiClientOptions {
	/** Override the discovery base dir (default: `~/.aizuchi/`). */
	baseDir?: string;
	/**
	 * Override `globalThis.fetch`. Used by tests to stub HTTP without
	 * monkey-patching globals. Falls back to `globalThis.fetch`.
	 */
	fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	query?: Record<string, string | undefined>;
	auth?: boolean;
}

const PROTOCOL_PREFIX = "/v1";

export class AizuchiClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: typeof globalThis.fetch;

	private constructor(config: IpcConfig, fetchImpl: typeof globalThis.fetch) {
		this.baseUrl = config.baseUrl;
		this.token = config.token;
		this.fetchImpl = fetchImpl;
	}

	/**
	 * Discover the running app and construct a client. Throws
	 * `AppNotRunningError` if the discovery files are missing,
	 * `TokenPermsError` if the token file is group/world-readable.
	 */
	static async create(
		options: AizuchiClientOptions = {},
	): Promise<AizuchiClient> {
		const config = await loadIpcConfig(options.baseDir);
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new IpcClientError(
				"no_fetch",
				"global fetch is not available; pass options.fetch explicitly.",
			);
		}
		return new AizuchiClient(config, fetchImpl);
	}

	/** Construct a client from an explicit config (skips discovery). */
	static fromConfig(
		config: IpcConfig,
		options: { fetch?: typeof globalThis.fetch } = {},
	): AizuchiClient {
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new IpcClientError(
				"no_fetch",
				"global fetch is not available; pass options.fetch explicitly.",
			);
		}
		return new AizuchiClient(config, fetchImpl);
	}

	// =====================================================================
	// App
	// =====================================================================

	/**
	 * `GET /v1/app/status`. The only unauthenticated endpoint — also used
	 * as a "is the app running" probe.
	 */
	status(): Promise<AppStatus> {
		return this.request<AppStatus>("/app/status", { auth: false });
	}

	// =====================================================================
	// Pads
	// =====================================================================

	listPads(opts: ListPadsOptions = {}): Promise<Note[]> {
		const query: Record<string, string | undefined> = {};
		if (opts.include) query.include = opts.include;
		if (opts.only) query.only = opts.only;
		return this.request<{ pads: Note[] }>("/pads", { query }).then(
			(r) => r.pads,
		);
	}

	createPad(input: CreatePadInput): Promise<Note> {
		return this.request<Note>("/pads", { method: "POST", body: input });
	}

	getPad(id: string): Promise<Note> {
		return this.request<Note>(`/pads/${encodeURIComponent(id)}`);
	}

	updatePad(id: string, patch: PadPatch): Promise<Note> {
		return this.request<Note>(`/pads/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: patch,
		});
	}

	deletePad(id: string): Promise<void> {
		return this.request<void>(`/pads/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	}

	hidePad(id: string): Promise<Note> {
		return this.request<Note>(`/pads/${encodeURIComponent(id)}/hide`, {
			method: "POST",
		});
	}

	showPad(id: string): Promise<Note> {
		return this.request<Note>(`/pads/${encodeURIComponent(id)}/show`, {
			method: "POST",
		});
	}

	showAllHidden(): Promise<{ restored: number }> {
		return this.request<{ restored: number }>("/pads/show-hidden", {
			method: "POST",
		});
	}

	focusPad(id: string): Promise<void> {
		// Server returns `{ ok: true }`, but the user-facing contract is
		// fire-and-forget — drop the body.
		return this.request<{ ok: true }>(`/pads/${encodeURIComponent(id)}/focus`, {
			method: "POST",
		}).then(() => undefined);
	}

	// =====================================================================
	// Meetings
	// =====================================================================

	listMeetings(): Promise<MeetingMeta[]> {
		return this.request<{ meetings: MeetingMeta[] }>("/meetings").then(
			(r) => r.meetings,
		);
	}

	getMeeting(id: string): Promise<MeetingSnapshot> {
		return this.request<MeetingSnapshot>(`/meetings/${encodeURIComponent(id)}`);
	}

	deleteMeeting(id: string): Promise<void> {
		return this.request<void>(`/meetings/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	}

	renameMeeting(
		id: string,
		name?: string,
		nameLockedByUser?: boolean,
	): Promise<MeetingMeta> {
		const body: RenameMeetingInput = {};
		if (name !== undefined) body.name = name;
		if (nameLockedByUser !== undefined)
			body.nameLockedByUser = nameLockedByUser;
		return this.request<MeetingMeta>(`/meetings/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body,
		});
	}

	startMeeting(mode: MeetingMode): Promise<StartMeetingResponse> {
		return this.request<StartMeetingResponse>("/meetings", {
			method: "POST",
			body: { mode },
		});
	}

	importMeeting(input: ImportMeetingInput): Promise<ImportMeetingResponse> {
		return this.request<ImportMeetingResponse>("/meetings/import", {
			method: "POST",
			body: input,
		});
	}

	stopMeeting(id: string): Promise<MeetingMeta> {
		return this.request<MeetingMeta>(
			`/meetings/${encodeURIComponent(id)}/stop`,
			{ method: "POST" },
		);
	}

	resumeMeeting(id: string): Promise<ResumeMeetingResponse> {
		return this.request<ResumeMeetingResponse>(
			`/meetings/${encodeURIComponent(id)}/resume`,
			{ method: "POST" },
		);
	}

	openMeeting(id: string): Promise<{ ok: true }> {
		return this.request<{ ok: true }>(
			`/meetings/${encodeURIComponent(id)}/open`,
			{ method: "POST" },
		);
	}

	// =====================================================================
	// Internal: request helper
	// =====================================================================

	private async request<T>(
		pathname: string,
		options: RequestOptions = {},
	): Promise<T> {
		const headers: Record<string, string> = {};
		if (options.auth !== false) {
			headers.authorization = `Bearer ${this.token}`;
		}
		if (options.body !== undefined) {
			headers["content-type"] = "application/json";
		}

		let url = this.baseUrl + PROTOCOL_PREFIX + pathname;
		if (options.query) {
			const usp = new URLSearchParams();
			for (const [k, v] of Object.entries(options.query)) {
				if (v !== undefined && v !== null && v !== "") usp.set(k, v);
			}
			const qs = usp.toString();
			if (qs.length > 0) url += `?${qs}`;
		}

		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method: options.method ?? "GET",
				headers,
				body:
					options.body !== undefined ? JSON.stringify(options.body) : undefined,
			});
		} catch (err) {
			throw mapNetworkError(err);
		}

		// 204 No Content — no body to parse.
		if (res.status === 204) {
			return undefined as T;
		}

		const text = await res.text();
		if (!res.ok) {
			throw await parseServerError(res.status, text);
		}

		if (text.length === 0) {
			return undefined as T;
		}

		try {
			return JSON.parse(text) as T;
		} catch (err) {
			throw new IpcClientError(
				"invalid_response",
				`Server returned non-JSON response (status ${res.status}).`,
				{ text, parseError: describeError(err) },
			);
		}
	}
}

function mapNetworkError(err: unknown): IpcClientError {
	const message = describeError(err);
	const lower = message.toLowerCase();
	// Bun, Node undici, and most network stacks surface ECONNREFUSED in
	// either the message string or as a `cause.code`. Normalise both.
	const causeCode =
		typeof err === "object" && err !== null && "cause" in err
			? // biome-ignore lint/suspicious/noExplicitAny: introspecting unknown error shape
				(err as any).cause?.code
			: undefined;
	if (
		causeCode === "ECONNREFUSED" ||
		lower.includes("econnrefused") ||
		lower.includes("connection refused")
	) {
		return new AppNotRunningError(
			"Could not connect to the Aizuchi IPC server. The discovery file may be stale — is the app actually running?",
			err,
		);
	}
	return new IpcClientError("network_error", message, err);
}

async function parseServerError(
	status: number,
	rawBody: string,
): Promise<IpcClientError> {
	if (rawBody.length === 0) {
		return new IpcClientError(
			"http_error",
			`Server returned HTTP ${status} with no body.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return new IpcClientError(
			"http_error",
			`Server returned HTTP ${status} with non-JSON body.`,
			{ rawBody },
		);
	}
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"error" in parsed &&
		typeof (parsed as { error: unknown }).error === "object" &&
		(parsed as { error: object }).error !== null
	) {
		const env = (
			parsed as {
				error: { code?: string; message?: string; details?: unknown };
			}
		).error;
		const code = typeof env.code === "string" ? env.code : "internal";
		const message =
			typeof env.message === "string" ? env.message : `HTTP ${status}`;
		return errorFromServer(code, message, env.details);
	}
	return new IpcClientError(
		"http_error",
		`Server returned HTTP ${status}.`,
		parsed,
	);
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
