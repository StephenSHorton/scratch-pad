import { describe, expect, it } from "bun:test";

import {
	AuthError,
	ConflictError,
	errorFromServer,
	IpcClientError,
	NotFoundError,
	ValidationError,
} from "./errors";

describe("errorFromServer code → class mapping", () => {
	it("maps auth_required to AuthError", () => {
		const err = errorFromServer("auth_required", "Missing Authorization");
		expect(err).toBeInstanceOf(AuthError);
		expect(err.code).toBe("auth_required");
		expect(err.message).toBe("Missing Authorization");
	});

	it("maps auth_invalid to AuthError", () => {
		const err = errorFromServer("auth_invalid", "Invalid token");
		expect(err).toBeInstanceOf(AuthError);
		expect(err.code).toBe("auth_invalid");
	});

	it("maps not_found to NotFoundError", () => {
		const err = errorFromServer("not_found", "Not found");
		expect(err).toBeInstanceOf(NotFoundError);
		expect(err.code).toBe("not_found");
	});

	it("maps validation_error to ValidationError", () => {
		const err = errorFromServer("validation_error", "bad body");
		expect(err).toBeInstanceOf(ValidationError);
		expect(err.code).toBe("validation_error");
	});

	it("maps id_invalid to ValidationError (same class, distinct code)", () => {
		const err = errorFromServer("id_invalid", "bad id");
		expect(err).toBeInstanceOf(ValidationError);
		expect(err.code).toBe("id_invalid");
	});

	it("maps conflict to ConflictError", () => {
		const err = errorFromServer("conflict", "already running");
		expect(err).toBeInstanceOf(ConflictError);
		expect(err.code).toBe("conflict");
	});

	it("falls back to IpcClientError for unknown codes (preserves code)", () => {
		const err = errorFromServer("method_not_allowed", "GET only");
		expect(err).toBeInstanceOf(IpcClientError);
		// Should NOT be one of the typed subclasses.
		expect(err).not.toBeInstanceOf(AuthError);
		expect(err).not.toBeInstanceOf(NotFoundError);
		expect(err).not.toBeInstanceOf(ValidationError);
		expect(err).not.toBeInstanceOf(ConflictError);
		expect(err.code).toBe("method_not_allowed");
	});

	it("preserves details payload on wrapping", () => {
		const details = { foo: 1 };
		const err = errorFromServer("internal", "boom", details);
		expect(err.details).toEqual(details);
	});
});
