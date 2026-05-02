import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AizuchiClient } from "./client";
import {
	AppNotRunningError,
	AuthError,
	ConflictError,
	IpcClientError,
	NotFoundError,
	ValidationError,
} from "./errors";

const VALID_TOKEN =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let tmpDir = "";

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-core-client-"));
	const tokenPath = path.join(tmpDir, "cli-token");
	await fs.writeFile(tokenPath, `${VALID_TOKEN}\n`, "utf-8");
	if (process.platform !== "win32") await fs.chmod(tokenPath, 0o600);
	await fs.writeFile(path.join(tmpDir, "cli.port"), "12345\n", "utf-8");
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// noop
	}
});

interface MockCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

function makeFetchMock(
	respond: (call: MockCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: MockCall[] } {
	const calls: MockCall[] = [];
	// We don't need the full surface of `typeof fetch` (preconnect etc.);
	// the client only ever calls the function form. Cast to satisfy the
	// type while keeping the mock minimal.
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = typeof input === "string" ? input : input.toString();
		const headers: Record<string, string> = {};
		const initHeaders = init?.headers;
		if (initHeaders) {
			if (initHeaders instanceof Headers) {
				initHeaders.forEach((v, k) => {
					headers[k.toLowerCase()] = v;
				});
			} else if (Array.isArray(initHeaders)) {
				for (const [k, v] of initHeaders) headers[k.toLowerCase()] = v;
			} else {
				for (const [k, v] of Object.entries(initHeaders))
					headers[k.toLowerCase()] = String(v);
			}
		}
		const call: MockCall = {
			url,
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		calls.push(call);
		return respond(call);
	}) as unknown as typeof globalThis.fetch;
	return { fetch: fetchFn, calls };
}

describe("AizuchiClient", () => {
	it("status() hits /v1/app/status without an Authorization header", async () => {
		const { fetch, calls } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						ok: true,
						app: { version: "1.2.3", name: "Aizuchi" },
						ipc: { version: 1, startedAt: 17_000_000 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		const status = await client.status();
		expect(status.ok).toBe(true);
		expect(status.ipc.version).toBe(1);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://127.0.0.1:12345/v1/app/status");
		expect(calls[0].headers.authorization).toBeUndefined();
	});

	it("listPads() unwraps the {pads:[…]} envelope and sends the bearer token", async () => {
		const fakePads = [
			{
				id: "abc",
				body: "x",
				color: "yellow",
				createdAt: "now",
				hidden: false,
			},
		];
		const { fetch, calls } = makeFetchMock(
			() =>
				new Response(JSON.stringify({ pads: fakePads }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		const pads = await client.listPads();
		expect(pads).toEqual(fakePads);
		expect(calls[0].headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
	});

	it("listPads({only:'hidden'}) builds the query string", async () => {
		const { fetch, calls } = makeFetchMock(
			() => new Response(JSON.stringify({ pads: [] }), { status: 200 }),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await client.listPads({ only: "hidden" });
		expect(calls[0].url).toBe("http://127.0.0.1:12345/v1/pads?only=hidden");
	});

	it("createPad() sends JSON body", async () => {
		const { fetch, calls } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						id: "new",
						body: "hi",
						color: "yellow",
						createdAt: "now",
						hidden: false,
					}),
					{ status: 200 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await client.createPad({ body: "hi", title: "t" });
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers["content-type"]).toBe("application/json");
		expect(JSON.parse(calls[0].body ?? "")).toEqual({ body: "hi", title: "t" });
	});

	it("deletePad() handles 204 and returns void", async () => {
		const { fetch } = makeFetchMock(() => new Response(null, { status: 204 }));
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		const result = await client.deletePad("abc");
		expect(result).toBeUndefined();
	});

	it("maps server not_found to NotFoundError", async () => {
		const { fetch } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "not_found", message: "Not found" },
					}),
					{ status: 404 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await expect(client.getPad("missing")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	it("maps server auth_invalid to AuthError", async () => {
		const { fetch } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "auth_invalid", message: "Invalid token" },
					}),
					{ status: 403 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await expect(client.listPads()).rejects.toBeInstanceOf(AuthError);
	});

	it("maps server validation_error to ValidationError", async () => {
		const { fetch } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "validation_error", message: "bad body" },
					}),
					{ status: 400 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await expect(client.updatePad("x", { body: "y" })).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	it("maps server conflict to ConflictError", async () => {
		const { fetch } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "conflict", message: "already running" },
					}),
					{ status: 409 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await expect(client.startMeeting("live")).rejects.toBeInstanceOf(
			ConflictError,
		);
	});

	it("maps unknown server codes to IpcClientError preserving the code", async () => {
		const { fetch } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "method_not_allowed", message: "GET only" },
					}),
					{ status: 405 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		try {
			await client.startMeeting("live");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(IpcClientError);
			expect((err as IpcClientError).code).toBe("method_not_allowed");
		}
	});

	it("translates ECONNREFUSED to AppNotRunningError", async () => {
		const refused = Object.assign(
			new Error("connect ECONNREFUSED 127.0.0.1:12345"),
			{
				code: "ECONNREFUSED",
			},
		);
		const { fetch } = makeFetchMock(() => {
			throw refused;
		});
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await expect(client.status()).rejects.toBeInstanceOf(AppNotRunningError);
	});

	it("renameMeeting() omits undefined fields from the patch body", async () => {
		const { fetch, calls } = makeFetchMock(
			() =>
				new Response(
					JSON.stringify({
						id: "m",
						startedAt: 0,
						endedAt: 0,
						mode: "live",
						nodeCount: 0,
						edgeCount: 0,
						thoughtCount: 0,
						transcriptDurationMs: 0,
					}),
					{ status: 200 },
				),
		);
		const client = await AizuchiClient.create({ baseDir: tmpDir, fetch });
		await client.renameMeeting("m", "Nice name");
		const sent = JSON.parse(calls[0].body ?? "{}");
		expect(sent).toEqual({ name: "Nice name" });
	});
});
