/**
 * Smoke tests for the Scratch Pad MCP server.
 *
 * Spawns the dev entry point as a subprocess, drives the MCP stdio
 * protocol by hand (initialize → tools/list), and verifies every tool
 * has a description + non-empty input schema.
 *
 * Live IPC behaviour (calling tools against a running Tauri app) is
 * out of scope here — that would need `bun tauri dev` running, which
 * isn't reasonable in CI. Manual smoke is documented in the PR body.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTRY = path.join(import.meta.dir, "index.ts");

interface ToolDef {
	name: string;
	description?: string;
	inputSchema?: { type?: string; properties?: Record<string, unknown> };
}

let cachedTools: ToolDef[] | null = null;
let tmpHomeDir = "";

async function listTools(): Promise<ToolDef[]> {
	if (cachedTools) return cachedTools;

	// Point HOME at an empty dir so discovery fails fast — initialize
	// + tools/list don't actually call any IPC endpoint, but having an
	// empty home insulates the test from the developer's running app.
	tmpHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-home-"));

	const proc = Bun.spawn(["bun", ENTRY], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
		env: { ...process.env, HOME: tmpHomeDir },
	});

	const stdin = proc.stdin as { write(s: string): number; flush(): Promise<void> };
	stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "smoke", version: "0" },
			},
		})}\n`,
	);
	stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
			params: {},
		})}\n`,
	);
	stdin.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		})}\n`,
	);
	await stdin.flush();

	// Read until we see id:2 response.
	const reader = proc.stdout.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let toolsResp: { result: { tools: ToolDef[] } } | null = null;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id === 2 && msg.result?.tools) {
					toolsResp = msg as { result: { tools: ToolDef[] } };
					break;
				}
			} catch {
				// Ignore non-JSON noise.
			}
		}
		if (toolsResp) break;
	}

	try {
		proc.kill();
	} catch {}
	await proc.exited;

	if (!toolsResp) {
		throw new Error("Did not receive tools/list response within timeout");
	}
	cachedTools = toolsResp.result.tools;
	return cachedTools;
}

afterAll(async () => {
	if (tmpHomeDir) {
		try {
			await fs.rm(tmpHomeDir, { recursive: true, force: true });
		} catch {}
	}
});

describe("scratch-pad MCP server", () => {
	it("registers every expected tool", async () => {
		const tools = await listTools();
		const names = tools.map((t) => t.name).sort();

		const expected = [
			// Pad CRUD (IPC-backed).
			"note_create",
			"note_list",
			"note_read",
			"note_update",
			"note_move",
			"note_resize",
			"note_organize",
			"note_clear",
			// Block tools.
			"block_list",
			"block_highlight",
			"block_insert",
			"block_update",
			"block_delete",
			// Highlights.
			"note_highlight",
			"note_unhighlight",
			// Multiplayer / peer / log (residual direct FS).
			"peer_discover",
			"peer_list",
			"pad_subscribe",
			"room_host",
			"room_join",
			"peer_disconnect",
			"log_open",
			"log_close",
			"log_tail",
			"log_search",
			// Meetings (new in AIZ-23).
			"meeting_start",
			"meeting_stop",
			"meeting_resume",
			"meeting_list",
			"meeting_open",
			"meeting_rename",
			"meeting_delete",
			"meeting_get",
		].sort();

		expect(names).toEqual(expected);
	});

	it("every tool has a non-empty description and an object input schema", async () => {
		const tools = await listTools();
		for (const tool of tools) {
			expect(tool.description, `tool ${tool.name}: missing description`)
				.toBeDefined();
			expect(
				(tool.description ?? "").length,
				`tool ${tool.name}: empty description`,
			).toBeGreaterThan(0);
			expect(tool.inputSchema, `tool ${tool.name}: missing inputSchema`)
				.toBeDefined();
			expect(
				tool.inputSchema?.type,
				`tool ${tool.name}: inputSchema.type !== "object"`,
			).toBe("object");
		}
	});

	it("includes the Aizuchi meeting tools added in AIZ-23", async () => {
		const tools = await listTools();
		const names = new Set(tools.map((t) => t.name));
		const meetingTools = [
			"meeting_start",
			"meeting_stop",
			"meeting_resume",
			"meeting_list",
			"meeting_open",
			"meeting_rename",
			"meeting_delete",
			"meeting_get",
		];
		for (const name of meetingTools) {
			expect(names.has(name), `missing meeting tool: ${name}`).toBe(true);
		}
	});
});
