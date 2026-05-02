#!/usr/bin/env bun
/**
 * AIZ-20 — IPC smoke harness.
 *
 * Walks every endpoint in the v1 IPC catalog and asserts the basic
 * shapes. Reads the bound port and bearer token from `~/.scratch-pad/`.
 *
 * EXPECTS `bun tauri dev` (or a packaged build) to already be running.
 *
 * Run:
 *   bun run scripts/ipc-smoke.ts             # baseline checks
 *   bun run scripts/ipc-smoke.ts --meeting   # also exercise meeting start/stop
 *
 * Exits 0 on success, 1 on any assertion failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Args & discovery
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const includeMeeting = args.has("--meeting");

const root = path.join(os.homedir(), ".scratch-pad");
const tokenFile = path.join(root, "cli-token");
const portFile = path.join(root, "cli.port");
const metaFile = path.join(root, "cli.json");

function die(msg: string): never {
	console.error(`smoke: ${msg}`);
	process.exit(1);
}

if (!fs.existsSync(tokenFile)) die(`missing ${tokenFile}; is the app running?`);
if (!fs.existsSync(portFile)) die(`missing ${portFile}; is the app running?`);

const token = fs.readFileSync(tokenFile, "utf-8").trim();
const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
if (Number.isNaN(port)) die(`bad port file: ${portFile}`);

const baseUrl = `http://127.0.0.1:${port}/v1`;
console.log(`smoke: ${baseUrl} (token ${token.slice(0, 8)}…)`);

if (fs.existsSync(metaFile)) {
	// Touch the meta file once at startup so a malformed cli.json is loud,
	// not silent. We don't need the parsed contents — port + token are the
	// load-bearing handshake.
	JSON.parse(fs.readFileSync(metaFile, "utf-8"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;

function ok(label: string) {
	passes++;
	console.log(`  pass: ${label}`);
}

function fail(label: string, detail?: unknown) {
	failures++;
	console.error(`  FAIL: ${label}`);
	if (detail !== undefined) console.error("        ", detail);
}

interface CallOpts {
	method?: string;
	body?: unknown;
	auth?: boolean | string;
}

async function call(
	pathname: string,
	opts: CallOpts = {},
): Promise<{ status: number; body: unknown; raw: string }> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const auth = opts.auth ?? true;
	if (auth === true) headers.authorization = `Bearer ${token}`;
	else if (typeof auth === "string") headers.authorization = `Bearer ${auth}`;

	const res = await fetch(`${baseUrl}${pathname}`, {
		method: opts.method ?? "GET",
		headers,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	const raw = await res.text();
	let body: unknown = null;
	if (raw.length > 0) {
		try {
			body = JSON.parse(raw);
		} catch {
			body = raw;
		}
	}
	return { status: res.status, body, raw };
}

function assert(condition: unknown, label: string, detail?: unknown) {
	if (condition) ok(label);
	else fail(label, detail);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function appStatus() {
	const r = await call("/app/status", { auth: false });
	assert(r.status === 200, "GET /app/status (no auth) → 200", r);
	assert(
		typeof r.body === "object" && r.body !== null && "ok" in r.body,
		"status body has ok field",
		r.body,
	);
	const body = r.body as Record<string, unknown>;
	assert(body.ok === true, "status.ok === true", body);
	const ipc = body.ipc as Record<string, unknown> | undefined;
	assert(ipc?.version === 1, "status.ipc.version === 1", ipc);
	assert(
		typeof ipc?.startedAt === "number",
		"status.ipc.startedAt is number",
		ipc,
	);
}

async function authChecks() {
	const noAuth = await call("/pads", { auth: false });
	assert(noAuth.status === 401, "GET /pads no auth → 401", noAuth);
	const errBody = noAuth.body as Record<string, { code: string }>;
	assert(
		errBody?.error?.code === "auth_required",
		"code === auth_required",
		errBody,
	);

	const badAuth = await call("/pads", { auth: "definitely-wrong-token" });
	assert(badAuth.status === 403, "GET /pads bad token → 403", badAuth);
	const badBody = badAuth.body as Record<string, { code: string }>;
	assert(
		badBody?.error?.code === "auth_invalid",
		"code === auth_invalid",
		badBody,
	);
}

async function padCrud() {
	const list = await call("/pads");
	assert(list.status === 200, "GET /pads → 200", list);
	const listBody = list.body as { pads: unknown[] };
	assert(Array.isArray(listBody.pads), "pads is an array", listBody);

	// Create
	const created = await call("/pads", {
		method: "POST",
		body: {
			title: "smoke-test",
			body: "hello from ipc-smoke",
			color: "blue",
		},
	});
	assert(created.status === 200, "POST /pads → 200", created);
	const padId = (created.body as { id: string }).id;
	assert(
		typeof padId === "string" && padId.length > 0,
		"created pad has id",
		padId,
	);

	// Get
	const got = await call(`/pads/${padId}`);
	assert(got.status === 200, `GET /pads/${padId} → 200`, got);
	assert(
		(got.body as { body: string }).body === "hello from ipc-smoke",
		"get returned saved body",
		got.body,
	);

	// Patch
	const patched = await call(`/pads/${padId}`, {
		method: "PATCH",
		body: { color: "green", body: "patched" },
	});
	assert(patched.status === 200, "PATCH /pads/:id → 200", patched);
	assert(
		(patched.body as { color: string }).color === "green",
		"patch updated color",
		patched.body,
	);

	// Empty patch should be 400
	const emptyPatch = await call(`/pads/${padId}`, {
		method: "PATCH",
		body: {},
	});
	assert(
		emptyPatch.status === 400 &&
			(emptyPatch.body as { error: { code: string } })?.error?.code ===
				"validation_error",
		"empty PATCH → 400 validation_error",
		emptyPatch,
	);

	// Hide / show
	const hidden = await call(`/pads/${padId}/hide`, { method: "POST" });
	assert(hidden.status === 200, "POST /pads/:id/hide → 200", hidden);
	assert(
		(hidden.body as { hidden: boolean }).hidden === true,
		"pad is hidden",
		hidden.body,
	);

	const restored = await call(`/pads/${padId}/show`, { method: "POST" });
	assert(restored.status === 200, "POST /pads/:id/show → 200", restored);
	assert(
		(restored.body as { hidden: boolean }).hidden === false,
		"pad is visible again",
		restored.body,
	);

	// Show-hidden (bulk)
	const showAll = await call("/pads/show-hidden", { method: "POST" });
	assert(showAll.status === 200, "POST /pads/show-hidden → 200", showAll);
	assert(
		typeof (showAll.body as { restored: number }).restored === "number",
		"show-hidden returns count",
		showAll.body,
	);

	// Delete
	const deleted = await call(`/pads/${padId}`, { method: "DELETE" });
	assert(deleted.status === 204, "DELETE /pads/:id → 204", deleted);

	// Subsequent GET should 404
	const after = await call(`/pads/${padId}`);
	assert(after.status === 404, "GET deleted pad → 404", after);
	assert(
		(after.body as { error: { code: string } })?.error?.code === "not_found",
		"code === not_found",
		after.body,
	);
}

async function meetingsList() {
	const r = await call("/meetings");
	assert(r.status === 200, "GET /meetings → 200", r);
	assert(
		Array.isArray((r.body as { meetings: unknown[] }).meetings),
		"meetings is an array",
		r.body,
	);
}

async function methodNotAllowed() {
	const r = await call("/app/status", { method: "POST", auth: false });
	assert(r.status === 405, "POST /app/status → 405 method_not_allowed", r);
}

async function unknownRoute() {
	const r = await call("/nope/never");
	assert(r.status === 404, "unknown route → 404", r);
}

// Optional, requires --meeting and a willing user — opens windows.
async function meetingStartStop() {
	console.log(
		"\n[meeting] opening a live meeting window — close it manually after",
	);
	const start = await call("/meetings", {
		method: "POST",
		body: { mode: "live" },
	});
	assert(start.status === 200, "POST /meetings → 200", start);
	const meetingId = (start.body as { id: string }).id;
	assert(
		typeof meetingId === "string" && meetingId.startsWith("meeting-"),
		"meeting id has expected prefix",
		meetingId,
	);
	console.log(`  started ${meetingId}`);

	// Wait for the user to talk for ~10s so the snapshot has content.
	console.log("  speak into the mic for ~10s, then we'll send stop…");
	await new Promise((r) => setTimeout(r, 10_000));

	const stop = await call(`/meetings/${meetingId}/stop`, { method: "POST" });
	console.log(`  stop response: ${stop.status}`, stop.body);
	assert(
		stop.status === 200 || stop.status === 404,
		"stop returned terminal status",
		stop,
	);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await appStatus();
await authChecks();
await padCrud();
await meetingsList();
await methodNotAllowed();
await unknownRoute();
if (includeMeeting) await meetingStartStop();

console.log(`\nsmoke: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
process.exit(0);
