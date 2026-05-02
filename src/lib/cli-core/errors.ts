/**
 * Typed error classes for the Aizuchi IPC client.
 *
 * The server-side error codes are frozen by the v1 IPC contract — see
 * `src-tauri/src/cli_server/error.rs`. These classes are the canonical
 * mapping for TypeScript consumers (CLI, MCP server, anything else).
 *
 * Two of the classes (`AppNotRunningError`, `TokenPermsError`) are
 * synthetic — produced by the client itself when the discovery handshake
 * fails before a request is ever sent. The rest map 1:1 to server codes.
 */

/** Base class. Always carries the underlying `code` string. */
export class IpcClientError extends Error {
	readonly code: string;
	readonly details: unknown;

	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = "IpcClientError";
		this.code = code;
		this.details = details;
	}
}

/** Synthetic. Token / port file is missing, or `fetch` got ECONNREFUSED. */
export class AppNotRunningError extends IpcClientError {
	constructor(message: string, details?: unknown) {
		super("app_not_running", message, details);
		this.name = "AppNotRunningError";
	}
}

/** Synthetic. Token file exists but is group/world-readable. */
export class TokenPermsError extends IpcClientError {
	constructor(message: string, details?: unknown) {
		super("token_perms", message, details);
		this.name = "TokenPermsError";
	}
}

/** Server: `auth_required` (401) or `auth_invalid` (403). */
export class AuthError extends IpcClientError {
	constructor(code: string, message: string, details?: unknown) {
		super(code, message, details);
		this.name = "AuthError";
	}
}

/** Server: `not_found` (404). */
export class NotFoundError extends IpcClientError {
	constructor(message: string, details?: unknown) {
		super("not_found", message, details);
		this.name = "NotFoundError";
	}
}

/** Server: `validation_error` (400) or `id_invalid` (400). */
export class ValidationError extends IpcClientError {
	constructor(code: string, message: string, details?: unknown) {
		super(code, message, details);
		this.name = "ValidationError";
	}
}

/** Server: `conflict` (409). */
export class ConflictError extends IpcClientError {
	constructor(message: string, details?: unknown) {
		super("conflict", message, details);
		this.name = "ConflictError";
	}
}

/**
 * Map a server error code to the right typed class.
 * Unknown codes fall back to the base `IpcClientError`, preserving the
 * code so callers can still pattern-match on `err.code`.
 */
export function errorFromServer(
	code: string,
	message: string,
	details?: unknown,
): IpcClientError {
	switch (code) {
		case "auth_required":
		case "auth_invalid":
			return new AuthError(code, message, details);
		case "not_found":
			return new NotFoundError(message, details);
		case "validation_error":
		case "id_invalid":
			return new ValidationError(code, message, details);
		case "conflict":
			return new ConflictError(message, details);
		default:
			return new IpcClientError(code, message, details);
	}
}
