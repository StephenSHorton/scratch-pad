#!/usr/bin/env node
/**
 * Aizuchi MCP server.
 *
 * Phase 4 of AIZ-13 (AIZ-23): the CRUD path now goes through the shared
 * `AizuchiClient` from `src/lib/cli-core/`. Every "create / read /
 * update / delete" tool is a thin wrapper over the IPC server running
 * inside the Tauri app — there is no more direct `notes.json` access on
 * the CRUD path.
 *
 * Behaviour change vs. pre-AIZ-23: the MCP server now requires the
 * Tauri app to be running. CRUD calls without the app surface as a
 * friendly "app isn't running" message instead of silently writing to
 * ~/.aizuchi/notes.json.
 *
 * What still touches the filesystem directly (residual / explicitly
 * out of scope for this PR — folded in by a follow-up):
 *
 *   - `note_organize`               .organize signal file
 *   - `note_create` (scope != local) .share-{id} signal file
 *   - `note_clear`                  .retract-{id} signal files
 *   - `peer_discover`, `peer_list`  peers.json + remote-notes.json
 *   - `pad_subscribe`               subscriptions.json
 *   - `room_host`, `room_join`,
 *     `peer_disconnect`             .host-room / .join-room / etc.
 *   - `log_open`, `log_close`       .show-logs / .close-logs signals
 *   - `log_tail`, `log_search`      reads aizuchi.log
 *   - `note_highlight`,
 *     `note_unhighlight`            highlights.json
 *
 * The IPC layer doesn't expose endpoints for these yet (signal-file
 * channel) so they stay direct-FS until a future ticket extends the
 * contract.
 *
 * ## Cross-package import note
 *
 * `mcp-server/` is a sibling Bun package — its `package.json` has no
 * dependency on the parent repo. We pull in `AizuchiClient` via a
 * relative path that crosses the package boundary
 * (`../../src/lib/cli-core`). At runtime this works because
 * `bun build --compile --minify` (the `build:binary` script) bundles
 * every reachable module into the standalone sidecar binary, so the
 * cross-package path is purely a build-time concern. Future cleanup:
 * convert `cli-core` into a proper workspace package
 * (`@aizuchi/cli-core`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
	AppNotRunningError,
	IpcClientError,
	type MeetingMeta,
	type MeetingSnapshot,
	type Note,
	NotFoundError,
	AizuchiClient,
} from "../../src/lib/cli-core";

// ---------------------------------------------------------------------------
// Types — for direct-FS reads that aren't on the IPC contract yet.
// ---------------------------------------------------------------------------

interface NoteEnvelope {
	id: string;
	sender: string;
	senderId: string;
	scope: string;
	intent: string;
	title: string | null;
	body: string;
	color: string;
	timestamp: number;
	ttl: number;
}

interface PeerInfo {
	nodeId: string;
	name: string;
	addr: string;
	connectedAt: string;
	lastSeen: string;
}

type HighlightValue = string | { type: "blocks"; blocks: number[] };

// ---------------------------------------------------------------------------
// Filesystem helpers (residual — see file-level comment).
// ---------------------------------------------------------------------------

function notesDir(): string {
	return path.join(os.homedir(), ".aizuchi");
}

function ensureNotesDir(): void {
	const dir = notesDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function readRemoteNotes(): NoteEnvelope[] {
	const file = path.join(notesDir(), "remote-notes.json");
	if (!fs.existsSync(file)) return [];
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

function readPeers(): PeerInfo[] {
	const file = path.join(notesDir(), "peers.json");
	if (!fs.existsSync(file)) return [];
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

function writeSignalFile(name: string, data?: object): void {
	ensureNotesDir();
	const file = path.join(notesDir(), name);
	fs.writeFileSync(file, data ? JSON.stringify(data) : "", "utf-8");
}

function readHighlights(): Record<string, HighlightValue> {
	const file = path.join(notesDir(), "highlights.json");
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}

function writeHighlights(highlights: Record<string, HighlightValue>): void {
	ensureNotesDir();
	const file = path.join(notesDir(), "highlights.json");
	fs.writeFileSync(file, `${JSON.stringify(highlights, null, 2)}\n`, "utf-8");
}

function formatAge(timestampMs: number): string {
	const seconds = Math.floor((Date.now() - timestampMs) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

function log(msg: string): void {
	const timestamp = new Date().toISOString().replace("T", " ").replace("Z", "");
	const line = `[${timestamp}] [mcp] ${msg}\n`;
	try {
		fs.appendFileSync(path.join(notesDir(), "aizuchi.log"), line);
	} catch {}
}

// ---------------------------------------------------------------------------
// IPC client — lazily constructed, cached.
//
// Discovery touches the disk and verifies token perms, so we only do it
// once. If the app restarts mid-session the bound port may change and
// the cached client will surface stale-discovery errors; users can
// reconnect from Claude Code by restarting the MCP session.
// ---------------------------------------------------------------------------

let cachedClient: AizuchiClient | null = null;

async function getClient(): Promise<AizuchiClient> {
	if (cachedClient) return cachedClient;
	cachedClient = await AizuchiClient.create();
	return cachedClient;
}

interface ToolError {
	content: { type: "text"; text: string }[];
	isError?: true;
}

/**
 * Run an IPC-backed tool body. Wraps `AppNotRunningError` and other
 * `IpcClientError`s into MCP-friendly text responses; everything else
 * propagates so the SDK can surface it as a transport error.
 */
async function withClient<T extends { content: { type: "text"; text: string }[] }>(
	fn: (client: AizuchiClient) => Promise<T>,
): Promise<T | ToolError> {
	try {
		const client = await getClient();
		return await fn(client);
	} catch (err) {
		if (err instanceof AppNotRunningError) {
			// Drop the cached client so a future attempt re-discovers.
			cachedClient = null;
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Aizuchi app isn't running. Start it (open -a 'Aizuchi' " +
							"or `bun tauri dev`) and retry.",
					},
				],
				isError: true,
			};
		}
		if (err instanceof NotFoundError) {
			return {
				content: [
					{ type: "text" as const, text: err.message || "Not found." },
				],
				isError: true,
			};
		}
		if (err instanceof IpcClientError) {
			return {
				content: [
					{
						type: "text" as const,
						text: `IPC error (${err.code}): ${err.message}`,
					},
				],
				isError: true,
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			isError: true,
		};
	}
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
	name: "aizuchi",
	version: "1.0.0",
});

// =============================================================================
// Pad CRUD — all routed through the IPC server.
// =============================================================================

server.tool(
	"note_create",
	"Create a new scratch pad note on the desktop. Supports markdown content. The note appears as a floating window the user can see. Do not repeat the title in the body — the title is displayed separately above the body. Set scope to share the note with peers on the network. Choose a width and height appropriate for the content: use wider notes for tables or code blocks, taller notes for long lists, and compact sizes for short messages. The default is 380x320.",
	{
		body: z
			.string()
			.describe(
				"The note content (do not include the title here — it is shown separately)",
			),
		title: z
			.string()
			.optional()
			.describe("Optional note title (displayed separately above the body)"),
		color: z
			.enum(["yellow", "pink", "blue", "green"])
			.optional()
			.default("yellow")
			.describe("Note color (default: yellow)"),
		width: z
			.number()
			.optional()
			.describe(
				"Window width in pixels. Choose based on content — e.g. 300 for short messages, 500+ for tables or code. Default: 380",
			),
		height: z
			.number()
			.optional()
			.describe(
				"Window height in pixels. Choose based on content — e.g. 200 for brief notes, 400+ for long lists. Default: 320",
			),
		ttl: z
			.number()
			.optional()
			.describe("Hours until the note auto-expires"),
		scope: z
			.enum(["local", "team"])
			.or(z.string())
			.optional()
			.default("local")
			.describe(
				"Sharing scope: 'local' (default, no sharing), 'team' (share with all peers), or a named group",
			),
		intent: z
			.enum(["decision", "question", "context", "handoff", "fyi"])
			.optional()
			.default("fyi")
			.describe("Note intent when sharing (default: fyi)"),
	},
	async ({ body, title, color, width, height, ttl, scope, intent }) =>
		withClient(async (client) => {
			log(
				`note_create: "${title || "(untitled)"}" [${color}] ${
					width || 380
				}x${height || 320} scope=${scope}`,
			);
			const note = await client.createPad({
				body,
				title,
				color,
				width,
				height,
				ttlHours: ttl,
				scope,
				intent,
			});

			// Sharing routing isn't on the IPC contract yet — keep the
			// existing signal-file channel for the multiplayer flow.
			if (scope && scope !== "local") {
				writeSignalFile(`.share-${note.id}`, { scope, intent });
			}

			const shared =
				scope && scope !== "local" ? ` | Shared to ${scope} [${intent}]` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Created note ${note.id}${
							note.title ? ` ("${note.title}")` : ""
						} [${note.color}]${shared}`,
					},
				],
			};
		}),
);

server.tool(
	"note_list",
	"List all active scratch pad notes (local and network) with their full content",
	{},
	async () =>
		withClient(async (client) => {
			log("note_list");
			const local = await client.listPads();

			let text = "";
			if (local.length === 0) {
				text = "No active local notes.";
			} else {
				const lines = local.map((n) => formatNoteListEntry(n));
				text = `${local.length} active note(s):\n\n${lines.join(
					"\n\n---\n\n",
				)}`;
			}

			// Remote notes still come from the disk — peer notes aren't on
			// the IPC contract yet.
			const remoteNotes = readRemoteNotes();
			if (remoteNotes.length > 0) {
				text += `\n\n## Network Notes (${remoteNotes.length})\n\n`;
				for (const rn of remoteNotes) {
					const age = formatAge(rn.timestamp);
					text += `### [${rn.intent}] from ${rn.sender} (${age})\n`;
					if (rn.title) text += `**${rn.title}**\n`;
					text += `${rn.body}\n`;
					text += `ID: ${rn.id} | Scope: ${rn.scope} | TTL: ${
						rn.ttl === 0 ? "session" : `${rn.ttl}s`
					}\n\n`;
				}
			} else {
				text += `\n\n## Network Notes\n\nNo network notes available.`;
			}

			return { content: [{ type: "text" as const, text }] };
		}),
);

function formatNoteListEntry(n: Note): string {
	const parts = [`## ${n.title || "(untitled)"} [${n.color}]`, `ID: ${n.id}`];
	parts.push(`Created: ${new Date(n.createdAt).toLocaleString()}`);
	if (n.expiresAt) {
		parts.push(`Expires: ${new Date(n.expiresAt).toLocaleString()}`);
	}
	if (n.position) {
		parts.push(`Position: (${n.position.x}, ${n.position.y})`);
	}
	if (n.size) {
		parts.push(`Size: ${n.size.width}x${n.size.height}`);
	}
	parts.push("", n.body);
	return parts.join("\n");
}

server.tool(
	"note_read",
	"Read the full content of a specific scratch pad note by ID",
	{
		id: z.string().describe("The ID of the note to read"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`note_read: ${id}`);
			try {
				const note = await client.getPad(id);
				const titleLine = note.title ? `# ${note.title}\n\n` : "";
				const meta = `[${note.color}] Created: ${new Date(
					note.createdAt,
				).toLocaleString()}`;
				const expires = note.expiresAt
					? ` | Expires: ${new Date(note.expiresAt).toLocaleString()}`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${titleLine}${note.body}\n\n---\n${meta}${expires}\nID: ${note.id}`,
						},
					],
				};
			} catch (err) {
				if (err instanceof NotFoundError) {
					// Try remote notes — peer notes aren't on the IPC contract.
					const remoteNote = readRemoteNotes().find((n) => n.id === id);
					if (remoteNote) {
						let text = "";
						if (remoteNote.title) text += `# ${remoteNote.title}\n\n`;
						text += remoteNote.body;
						text += `\n\n---\nFrom: ${remoteNote.sender} | Intent: ${remoteNote.intent} | Scope: ${remoteNote.scope}`;
						text += `\nReceived: ${formatAge(
							remoteNote.timestamp,
						)} | TTL: ${
							remoteNote.ttl === 0 ? "session" : `${remoteNote.ttl}s`
						}`;
						text += `\nID: ${remoteNote.id}`;
						return { content: [{ type: "text" as const, text }] };
					}
					return {
						content: [
							{ type: "text" as const, text: `Note ${id} not found.` },
						],
					};
				}
				throw err;
			}
		}),
);

server.tool(
	"note_update",
	"Update an existing scratch pad note — change its body, title, or color",
	{
		id: z.string().describe("The ID of the note to update"),
		body: z.string().optional().describe("New body content (replaces existing)"),
		title: z.string().optional().describe("New title (replaces existing)"),
		color: z
			.enum(["yellow", "pink", "blue", "green"])
			.optional()
			.describe("New color"),
	},
	async ({ id, body, title, color }) =>
		withClient(async (client) => {
			log(`note_update: ${id}`);
			const patch: { body?: string; title?: string; color?: string } = {};
			if (body !== undefined) patch.body = body;
			if (title !== undefined) patch.title = title;
			if (color !== undefined) patch.color = color;
			if (Object.keys(patch).length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Nothing to update — pass body, title, or color.",
						},
					],
				};
			}
			const note = await client.updatePad(id, patch);
			return {
				content: [
					{
						type: "text" as const,
						text: `Updated note ${note.id}${
							note.title ? ` ("${note.title}")` : ""
						}`,
					},
				],
			};
		}),
);

server.tool(
	"note_move",
	"Move a scratch pad note to a specific screen position",
	{
		id: z.string().describe("The ID of the note to move"),
		x: z.number().describe("X position in screen pixels"),
		y: z.number().describe("Y position in screen pixels"),
	},
	async ({ id, x, y }) =>
		withClient(async (client) => {
			log(`note_move: ${id} to (${x}, ${y})`);
			await client.updatePad(id, { position: { x, y } });
			return {
				content: [
					{ type: "text" as const, text: `Moved note ${id} to (${x}, ${y})` },
				],
			};
		}),
);

server.tool(
	"note_resize",
	"Resize a scratch pad note window",
	{
		id: z.string().describe("The ID of the note to resize"),
		width: z.number().describe("Width in pixels"),
		height: z.number().describe("Height in pixels"),
	},
	async ({ id, width, height }) =>
		withClient(async (client) => {
			log(`note_resize: ${id} to ${width}x${height}`);
			await client.updatePad(id, { size: { width, height } });
			return {
				content: [
					{
						type: "text" as const,
						text: `Resized note ${id} to ${width}x${height}`,
					},
				],
			};
		}),
);

server.tool(
	"note_organize",
	"Arrange all scratch pad notes in an optimal grid layout filling the screen. The app handles the actual layout using real screen dimensions.",
	{},
	async () =>
		withClient(async (client) => {
			log("note_organize");
			const local = await client.listPads();
			if (local.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No notes to organize." }],
				};
			}

			// Layout decision involves real screen dimensions, which the app
			// owns. Signal it via .organize and let the file watcher route
			// to organize_windows. (No IPC endpoint for this yet.)
			writeSignalFile(".organize");
			return {
				content: [
					{
						type: "text" as const,
						text: `Organizing ${local.length} note(s)`,
					},
				],
			};
		}),
);

server.tool(
	"note_clear",
	"Dismiss/delete one or all scratch pad notes",
	{
		id: z
			.string()
			.optional()
			.describe("ID of a specific note to dismiss. Omit to clear ALL notes."),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`note_clear: ${id || "all"}`);
			if (id) {
				try {
					await client.deletePad(id);
				} catch (err) {
					if (err instanceof NotFoundError) {
						return {
							content: [
								{ type: "text" as const, text: `Note ${id} not found.` },
							],
						};
					}
					throw err;
				}
				// Peer-side retract is signal-file-only for now.
				writeSignalFile(`.retract-${id}`);
				return {
					content: [{ type: "text" as const, text: `Dismissed note ${id}.` }],
				};
			}

			// Clear all — list and delete each. Emit retract signals so peers
			// can drop them client-side.
			const all = await client.listPads({ include: "hidden" });
			for (const note of all) {
				writeSignalFile(`.retract-${note.id}`);
				try {
					await client.deletePad(note.id);
				} catch (err) {
					if (!(err instanceof NotFoundError)) throw err;
				}
			}
			return {
				content: [{ type: "text" as const, text: "All notes cleared." }],
			};
		}),
);

// =============================================================================
// Multiplayer / peer tools — direct FS for now (signal files + state
// files outside the IPC contract). See file-level comment.
// =============================================================================

server.tool(
	"peer_discover",
	"List currently connected peers. Use room_host and room_join to connect with peers manually via room codes.",
	{},
	async () => {
		log("peer_discover");
		const peers = readPeers();
		if (peers.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: "No peers discovered on the network. Make sure other Aizuchi instances are running on the same LAN.",
					},
				],
			};
		}
		let text = `## Discovered Peers (${peers.length})\n\n`;
		for (const peer of peers) {
			text += `- **${peer.name}** (${peer.addr})\n`;
			text += `  Connected: ${peer.connectedAt} | Last seen: ${peer.lastSeen}\n`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

server.tool(
	"peer_list",
	"List currently connected peers with their status and shared note counts.",
	{},
	async () => {
		log("peer_list");
		const peers = readPeers();
		const remoteNotes = readRemoteNotes();
		if (peers.length === 0) {
			return {
				content: [
					{ type: "text" as const, text: "No peers currently connected." },
				],
			};
		}
		let text = `## Connected Peers (${peers.length})\n\n`;
		for (const peer of peers) {
			const noteCount = remoteNotes.filter(
				(n) => n.senderId === peer.nodeId,
			).length;
			text += `- **${peer.name}** — ${noteCount} shared note${
				noteCount !== 1 ? "s" : ""
			}\n`;
			text += `  Last seen: ${peer.lastSeen}\n`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

server.tool(
	"pad_subscribe",
	"Subscribe to notes from a specific scope. Controls which network notes you receive.",
	{
		scope: z
			.string()
			.optional()
			.describe(
				"Scope to subscribe to: 'team' or a named group (e.g., 'frontend', 'backend'). Omit to subscribe to all.",
			),
	},
	async ({ scope }) => {
		log(`pad_subscribe: ${scope || "all"}`);
		ensureNotesDir();
		const subsFile = path.join(notesDir(), "subscriptions.json");
		let subs: string[] = [];
		if (fs.existsSync(subsFile)) {
			try {
				subs = JSON.parse(fs.readFileSync(subsFile, "utf-8"));
			} catch {
				subs = [];
			}
		}
		if (scope) {
			if (!subs.includes(scope)) subs.push(scope);
			fs.writeFileSync(
				subsFile,
				`${JSON.stringify(subs, null, 2)}\n`,
				"utf-8",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Subscribed to scope: "${scope}". Current subscriptions: ${subs.join(", ")}`,
					},
				],
			};
		}
		// No scope = subscribe to all (delete subs file).
		if (fs.existsSync(subsFile)) fs.unlinkSync(subsFile);
		return {
			content: [
				{ type: "text" as const, text: "Subscribed to all scopes (no filtering)." },
			],
		};
	},
);

server.tool(
	"room_host",
	"Host a multiplayer room and get a room code to share with a teammate. The code encodes your local IP and port — share it out-of-band (verbally, chat, etc.).",
	{},
	async () => {
		log("room_host");
		const resultFile = path.join(notesDir(), "room-code.json");
		if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
		writeSignalFile(".host-room");

		const maxWait = 5000;
		const pollInterval = 200;
		let waited = 0;
		while (waited < maxWait) {
			await new Promise((r) => setTimeout(r, pollInterval));
			waited += pollInterval;
			if (fs.existsSync(resultFile)) {
				try {
					const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
					fs.unlinkSync(resultFile);
					return {
						content: [
							{
								type: "text" as const,
								text: `Room hosted! Share this code with your teammate:\n\n**${result.code}**\n\nListening on ${result.ip}:${result.port}`,
							},
						],
					};
				} catch {
					break;
				}
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text: "Failed to host room — Aizuchi app may not be running.",
				},
			],
			isError: true,
		};
	},
);

server.tool(
	"room_join",
	"Join a multiplayer room using a room code from a teammate. Connects to their Aizuchi instance for real-time note sharing.",
	{
		code: z.string().describe("The room code from the host (e.g., XXXX-XXXX-XX)"),
	},
	async ({ code }) => {
		log(`room_join: ${code}`);
		const resultFile = path.join(notesDir(), "room-result.json");
		if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
		writeSignalFile(".join-room", { code });

		const maxWait = 15000;
		const pollInterval = 300;
		let waited = 0;
		while (waited < maxWait) {
			await new Promise((r) => setTimeout(r, pollInterval));
			waited += pollInterval;
			if (fs.existsSync(resultFile)) {
				try {
					const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
					fs.unlinkSync(resultFile);
					if (result.success) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Connected to **${result.peer_name}** (${result.peer_id}). You can now share notes with scope "team".`,
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to join room: ${result.error}`,
							},
						],
						isError: true,
					};
				} catch {
					break;
				}
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text: "Join timed out — check that the host is running Aizuchi and the code is correct.",
				},
			],
			isError: true,
		};
	},
);

server.tool(
	"peer_disconnect",
	"Disconnect from a specific peer.",
	{
		node_id: z
			.string()
			.describe(
				"The node ID of the peer to disconnect (from peer_discover or peer_list)",
			),
	},
	async ({ node_id }) => {
		log(`peer_disconnect: ${node_id}`);
		writeSignalFile(".disconnect-peer", { nodeId: node_id });
		return {
			content: [
				{ type: "text" as const, text: `Disconnecting from peer ${node_id}.` },
			],
		};
	},
);

// =============================================================================
// Log viewer + log search — direct FS for now.
// =============================================================================

server.tool(
	"log_open",
	"Open the live log viewer as a floating sticky note. Optionally pass a filter to only show matching entries.",
	{
		filter: z
			.string()
			.optional()
			.describe(
				"Only show log lines containing this text (e.g., 'network', 'mcp', 'error')",
			),
	},
	async ({ filter }) => {
		log(`log_open: ${filter || "unfiltered"}`);
		writeSignalFile(".show-logs", filter ? { filter } : undefined);
		return {
			content: [
				{
					type: "text" as const,
					text: `Log viewer opened${filter ? ` with filter: "${filter}"` : ""}.`,
				},
			],
		};
	},
);

server.tool(
	"log_close",
	"Close the live log viewer window.",
	{},
	async () => {
		log("log_close");
		writeSignalFile(".close-logs");
		return {
			content: [{ type: "text" as const, text: "Log viewer closed." }],
		};
	},
);

function readLogFile(): string {
	const file = path.join(notesDir(), "aizuchi.log");
	if (!fs.existsSync(file)) return "";
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

server.tool(
	"log_tail",
	"Read the most recent log entries from Aizuchi. Useful for debugging network, MCP, and app events.",
	{
		lines: z
			.number()
			.optional()
			.describe("Number of lines to return (default 50, max 500)"),
		filter: z
			.string()
			.optional()
			.describe(
				"Optional filter — only return lines containing this string (e.g., 'network', 'mcp', 'error')",
			),
	},
	async ({ lines, filter }) => {
		const maxLines = Math.min(lines ?? 50, 500);
		const content = readLogFile();
		let allLines = content.split("\n").filter((l) => l.trim());
		if (filter) {
			const lowerFilter = filter.toLowerCase();
			allLines = allLines.filter((l) => l.toLowerCase().includes(lowerFilter));
		}
		const start = Math.max(0, allLines.length - maxLines);
		const result = allLines.slice(start).join("\n");
		return {
			content: [
				{ type: "text" as const, text: result || "No log entries found." },
			],
		};
	},
);

server.tool(
	"log_search",
	"Search Aizuchi logs by keyword, time range, or category. Returns matching entries with context.",
	{
		query: z.string().describe("Search term to find in log entries"),
		category: z
			.enum(["mcp", "network", "all"])
			.optional()
			.describe("Filter by log category (default: all)"),
		last_minutes: z
			.number()
			.optional()
			.describe(
				"Only search entries from the last N minutes (default: no time limit)",
			),
	},
	async ({ query, category, last_minutes }) => {
		const content = readLogFile();
		let allLines = content.split("\n").filter((l) => l.trim());
		if (category && category !== "all") {
			allLines = allLines.filter((l) => l.includes(`[${category}]`));
		}
		if (last_minutes) {
			const cutoff = Date.now() - last_minutes * 60 * 1000;
			allLines = allLines.filter((l) => {
				const match = l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
				if (!match) return false;
				const ts = new Date(`${match[1].replace(" ", "T")}Z`).getTime();
				return ts >= cutoff;
			});
		}
		const lowerQuery = query.toLowerCase();
		const matches = allLines.filter((l) => l.toLowerCase().includes(lowerQuery));
		if (matches.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: `No log entries matching "${query}"${category ? ` in [${category}]` : ""}${last_minutes ? ` from last ${last_minutes}m` : ""}.`,
					},
				],
			};
		}
		const capped = matches.slice(-200);
		let text = `## Log Search: "${query}" (${matches.length} matches)\n\n`;
		text += capped.join("\n");
		if (matches.length > 200) {
			text += `\n\n... (showing last 200 of ${matches.length} matches)`;
		}
		return { content: [{ type: "text" as const, text }] };
	},
);

// =============================================================================
// Highlights — direct FS (highlights.json), no IPC contract yet.
// =============================================================================

server.tool(
	"note_highlight",
	"Highlight matching content in a scratch pad and dim everything else. Draws the user's attention to specific information. The user can click the note to clear the highlight.",
	{
		id: z.string().describe("Note ID to highlight"),
		pattern: z
			.string()
			.describe(
				"Text pattern to highlight — matching lines stay bright, others are dimmed",
			),
	},
	async ({ id, pattern }) => {
		log(`note_highlight: ${id} pattern="${pattern}"`);
		const highlights = readHighlights();
		highlights[id] = pattern;
		writeHighlights(highlights);
		return {
			content: [
				{
					type: "text" as const,
					text: `Highlighting "${pattern}" in note ${id}. User can click the note to clear.`,
				},
			],
		};
	},
);

server.tool(
	"note_unhighlight",
	"Remove highlight/emphasis from a scratch pad, restoring normal display.",
	{
		id: z.string().describe("Note ID to unhighlight"),
	},
	async ({ id }) => {
		log(`note_unhighlight: ${id}`);
		const highlights = readHighlights();
		delete highlights[id];
		writeHighlights(highlights);
		return {
			content: [
				{ type: "text" as const, text: `Highlight removed from note ${id}.` },
			],
		};
	},
);

// =============================================================================
// Block tools — body-level edits go through the IPC PATCH endpoint, the
// markdown parsing/serialising stays in JS.
// =============================================================================

interface Block {
	index: number;
	type: "heading" | "paragraph" | "list" | "code" | "blank";
	text: string;
	raw: string;
}

function parseBlocks(body: string): Block[] {
	const lines = body.split("\n");
	const blocks: Block[] = [];
	let i = 0;
	let index = 0;

	const isHeading = (line: string) => /^#{1,6}\s+/.test(line);
	const isListItem = (line: string) => /^\s*([-*+]\s+|\d+\.\s+)/.test(line);
	const isFence = (line: string) => /^\s*```/.test(line);
	const isBlank = (line: string) => line.trim() === "";

	while (i < lines.length) {
		const line = lines[i];

		if (isBlank(line)) {
			blocks.push({ index: index++, type: "blank", text: "", raw: line });
			i++;
			continue;
		}

		if (isFence(line)) {
			const collected: string[] = [line];
			i++;
			while (i < lines.length && !isFence(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			if (i < lines.length && isFence(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			const raw = collected.join("\n");
			const text = collected
				.slice(
					1,
					collected[collected.length - 1] && isFence(collected[collected.length - 1])
						? -1
						: undefined,
				)
				.join("\n");
			blocks.push({ index: index++, type: "code", text, raw });
			continue;
		}

		if (isHeading(line)) {
			const text = line.replace(/^#{1,6}\s+/, "");
			blocks.push({ index: index++, type: "heading", text, raw: line });
			i++;
			continue;
		}

		if (isListItem(line)) {
			const collected: string[] = [];
			while (i < lines.length && isListItem(lines[i])) {
				collected.push(lines[i]);
				i++;
			}
			const raw = collected.join("\n");
			const text = collected
				.map((l) => l.replace(/^\s*([-*+]\s+|\d+\.\s+)/, ""))
				.join("\n");
			blocks.push({ index: index++, type: "list", text, raw });
			continue;
		}

		const collected: string[] = [];
		while (
			i < lines.length &&
			!isBlank(lines[i]) &&
			!isHeading(lines[i]) &&
			!isListItem(lines[i]) &&
			!isFence(lines[i])
		) {
			collected.push(lines[i]);
			i++;
		}
		const raw = collected.join("\n");
		blocks.push({ index: index++, type: "paragraph", text: raw, raw });
	}

	return blocks;
}

function blocksToMarkdown(blocks: Block[]): string {
	return blocks.map((b) => b.raw).join("\n");
}

server.tool(
	"block_list",
	"List all blocks in a scratch pad with their index, type, and content. Use this to find blocks before targeting them with block_highlight, block_update, etc.",
	{
		id: z.string().describe("Note ID"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`block_list: ${id}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (blocks.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Note ${id} has no blocks (empty body).`,
						},
					],
				};
			}
			const lines = blocks.map((b) => {
				const preview = b.raw.replace(/\n/g, "\\n");
				return `${b.index} [${b.type}] ${preview}`;
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `${blocks.length} block(s) in note ${id}:\n\n${lines.join("\n")}`,
					},
				],
			};
		}),
);

server.tool(
	"block_highlight",
	"Highlight specific blocks in a scratch pad by index and dim everything else. More precise than note_highlight (which uses pattern matching). Use block_list first to see available blocks.",
	{
		id: z.string().describe("Note ID"),
		blocks: z
			.array(z.number())
			.describe("Array of block indices to highlight (e.g., [0, 1, 2])"),
	},
	async ({ id, blocks }) =>
		withClient(async (client) => {
			log(`block_highlight: ${id} blocks=[${blocks.join(",")}]`);
			// Existence check via IPC.
			await client.getPad(id);
			const highlights = readHighlights();
			highlights[id] = { type: "blocks", blocks };
			writeHighlights(highlights);
			return {
				content: [
					{
						type: "text" as const,
						text: `Highlighting blocks [${blocks.join(", ")}] in note ${id}. User can click the note to clear.`,
					},
				],
			};
		}),
);

server.tool(
	"block_insert",
	"Insert a new block into a scratch pad after the specified index (use -1 to insert at the beginning).",
	{
		id: z.string().describe("Note ID"),
		after_index: z
			.number()
			.describe("Insert after this block index (-1 for beginning)"),
		content: z
			.string()
			.describe(
				"Markdown content for the new block (e.g., '## My Heading' or '- list item' or 'plain paragraph')",
			),
	},
	async ({ id, after_index, content }) =>
		withClient(async (client) => {
			log(`block_insert: ${id} after=${after_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			const newBlocks = parseBlocks(content);
			if (newBlocks.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "Cannot insert empty content." },
					],
				};
			}

			let insertAt: number;
			if (after_index < 0) insertAt = 0;
			else if (after_index >= blocks.length) insertAt = blocks.length;
			else insertAt = after_index + 1;

			const toInsert: Block[] = [];
			if (
				insertAt > 0 &&
				blocks[insertAt - 1] &&
				blocks[insertAt - 1].type !== "blank"
			) {
				toInsert.push({ index: 0, type: "blank", text: "", raw: "" });
			}
			toInsert.push(...newBlocks);
			if (insertAt < blocks.length && blocks[insertAt].type !== "blank") {
				toInsert.push({ index: 0, type: "blank", text: "", raw: "" });
			}

			blocks.splice(insertAt, 0, ...toInsert);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});

			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Inserted block(s) into note ${id} after index ${after_index}.`,
					},
				],
			};
		}),
);

server.tool(
	"block_update",
	"Replace the content of a specific block by index.",
	{
		id: z.string().describe("Note ID"),
		block_index: z.number().describe("Block index to replace"),
		content: z.string().describe("New markdown content for the block"),
	},
	async ({ id, block_index, content }) =>
		withClient(async (client) => {
			log(`block_update: ${id} block=${block_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (block_index < 0 || block_index >= blocks.length) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Block index ${block_index} out of range (note has ${blocks.length} block(s)).`,
						},
					],
				};
			}
			const replacementBlocks = parseBlocks(content);
			blocks.splice(block_index, 1, ...replacementBlocks);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});
			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Updated block ${block_index} in note ${id}.`,
					},
				],
			};
		}),
);

server.tool(
	"block_delete",
	"Delete a specific block from a scratch pad by index.",
	{
		id: z.string().describe("Note ID"),
		block_index: z.number().describe("Block index to delete"),
	},
	async ({ id, block_index }) =>
		withClient(async (client) => {
			log(`block_delete: ${id} block=${block_index}`);
			const note = await client.getPad(id);
			const blocks = parseBlocks(note.body);
			if (block_index < 0 || block_index >= blocks.length) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Block index ${block_index} out of range (note has ${blocks.length} block(s)).`,
						},
					],
				};
			}
			blocks.splice(block_index, 1);
			blocks.forEach((b, idx) => {
				b.index = idx;
			});
			const updatedBody = blocksToMarkdown(blocks);
			await client.updatePad(id, { body: updatedBody });
			return {
				content: [
					{
						type: "text" as const,
						text: `Deleted block ${block_index} from note ${id}.`,
					},
				],
			};
		}),
);

// =============================================================================
// Aizuchi meeting tools — all routed through the IPC server.
//
// Time fields below: `startedAt` / `endedAt` come straight from
// `MeetingMeta` and are i64 epoch milliseconds (NOT RFC3339). `Note.createdAt`
// from the pad tools is RFC3339.
// =============================================================================

function formatMeetingMeta(m: MeetingMeta): string {
	const started = new Date(m.startedAt).toLocaleString();
	const ended =
		m.endedAt && m.endedAt > 0
			? new Date(m.endedAt).toLocaleString()
			: "running";
	const duration =
		m.endedAt && m.endedAt > 0
			? formatDurationMs(m.endedAt - m.startedAt)
			: formatDurationMs(Date.now() - m.startedAt);
	const name = m.name ? ` "${m.name}"${m.nameLockedByUser ? " (locked)" : ""}` : "";
	const parts = [`## ${m.id}${name} [${m.mode}]`];
	parts.push(`Started: ${started}`);
	parts.push(`Ended: ${ended}`);
	parts.push(`Duration: ${duration}`);
	parts.push(
		`Nodes: ${m.nodeCount} | Edges: ${m.edgeCount} | Thoughts: ${m.thoughtCount}`,
	);
	if (m.transcriptDurationMs > 0) {
		parts.push(`Transcript: ${formatDurationMs(m.transcriptDurationMs)}`);
	}
	return parts.join("\n");
}

function formatDurationMs(ms: number): string {
	if (ms <= 0) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return remSec === 0 ? `${min}m` : `${min}m${remSec}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin === 0 ? `${hr}h` : `${hr}h${remMin}m`;
}

server.tool(
	"meeting_start",
	"Start a new Aizuchi meeting. Opens the meeting window and kicks off live ASR (mode='live') or the demo transcript (mode='demo'). Returns the meeting id and whether the window was opened.",
	{
		mode: z
			.enum(["demo", "live"])
			.describe(
				"'live' captures system + microphone audio with ASR. 'demo' replays the bundled fixture transcript — useful for testing without audio.",
			),
	},
	async ({ mode }) =>
		withClient(async (client) => {
			log(`meeting_start: ${mode}`);
			const result = await client.startMeeting(mode);
			return {
				content: [
					{
						type: "text" as const,
						text: `Started meeting ${result.id} (${mode})${
							result.openedWindow ? " — window opened" : ""
						}.`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_stop",
	"Stop the running live meeting. Waits up to ~3s for the React side to finish saving the snapshot, then returns the post-stop MeetingMeta. Time fields (startedAt, endedAt) are epoch milliseconds.",
	{
		id: z.string().describe("Meeting id (e.g., 'meeting-<uuid>')"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_stop: ${id}`);
			const meta = await client.stopMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Stopped meeting ${meta.id}.\n\n${formatMeetingMeta(meta)}`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_resume",
	"Resume / append to a previously stopped meeting. Re-opens the meeting window and re-attaches live capture; new transcript chunks append to the existing snapshot.",
	{
		id: z.string().describe("Meeting id to resume"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_resume: ${id}`);
			const result = await client.resumeMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: `Resumed meeting ${id}${
							result.windowOpened ? " — window opened" : ""
						}.`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_list",
	"List every saved Aizuchi meeting with its id, name, mode, duration, and node/edge/thought counts. Time fields are epoch milliseconds.",
	{},
	async () =>
		withClient(async (client) => {
			log("meeting_list");
			const meetings = await client.listMeetings();
			if (meetings.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "No saved meetings." },
					],
				};
			}
			// Newest first.
			const sorted = [...meetings].sort((a, b) => b.startedAt - a.startedAt);
			const text = `${meetings.length} meeting(s):\n\n${sorted
				.map(formatMeetingMeta)
				.join("\n\n---\n\n")}`;
			return { content: [{ type: "text" as const, text }] };
		}),
);

server.tool(
	"meeting_open",
	"Open the read-only meeting window for an existing meeting. Does not resume capture — use meeting_resume for that.",
	{
		id: z.string().describe("Meeting id to open"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_open: ${id}`);
			await client.openMeeting(id);
			return {
				content: [
					{ type: "text" as const, text: `Opened meeting window for ${id}.` },
				],
			};
		}),
);

server.tool(
	"meeting_rename",
	"Rename a meeting. The user-initiated rename always sets nameLockedByUser=true so the AI naming pass won't overwrite it.",
	{
		id: z.string().describe("Meeting id to rename"),
		name: z.string().describe("New display name for the meeting"),
	},
	async ({ id, name }) =>
		withClient(async (client) => {
			log(`meeting_rename: ${id} -> "${name}"`);
			const meta = await client.renameMeeting(id, name, true);
			return {
				content: [
					{
						type: "text" as const,
						text: `Renamed meeting ${id} to "${meta.name ?? name}" (locked).`,
					},
				],
			};
		}),
);

server.tool(
	"meeting_delete",
	"Permanently delete a saved meeting snapshot.",
	{
		id: z.string().describe("Meeting id to delete"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_delete: ${id}`);
			await client.deleteMeeting(id);
			return {
				content: [
					{ type: "text" as const, text: `Deleted meeting ${id}.` },
				],
			};
		}),
);

server.tool(
	"meeting_get",
	"Fetch the full snapshot of a meeting — graph, transcript, AI thoughts, passes, and stats. Returns JSON. Time fields (startedAt, endedAt, transcript chunks) are epoch milliseconds.",
	{
		id: z.string().describe("Meeting id to fetch"),
	},
	async ({ id }) =>
		withClient(async (client) => {
			log(`meeting_get: ${id}`);
			const snap: MeetingSnapshot = await client.getMeeting(id);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(snap, null, 2),
					},
				],
			};
		}),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
