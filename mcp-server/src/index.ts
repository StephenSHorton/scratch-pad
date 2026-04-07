#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Note {
  id: string;
  title: string | null;
  body: string;
  color: "yellow" | "pink" | "blue" | "green";
  createdAt: string;
  expiresAt: string | null;
  position: { x: number; y: number } | null;
  size: { width: number; height: number } | null;
}

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

function notesDir(): string {
  return path.join(os.homedir(), ".scratch-pad");
}

function notesFile(): string {
  return path.join(notesDir(), "notes.json");
}

function remoteNotesFile(): string {
  return path.join(notesDir(), "remote-notes.json");
}

function peersFile(): string {
  return path.join(notesDir(), "peers.json");
}

function readNotes(): Note[] {
  try {
    const raw = fs.readFileSync(notesFile(), "utf-8");
    return JSON.parse(raw) as Note[];
  } catch {
    return [];
  }
}

function writeNotes(notes: Note[]): void {
  const dir = notesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(notesFile(), JSON.stringify(notes, null, 2) + "\n", "utf-8");
}

function readRemoteNotes(): NoteEnvelope[] {
  const file = remoteNotesFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function readPeers(): PeerInfo[] {
  const file = peersFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function writeSignalFile(name: string, data?: object): void {
  const dir = notesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, data ? JSON.stringify(data) : "", "utf-8");
}

function formatAge(timestampMs: number): string {
  const seconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "scratch-pad",
  version: "1.0.0",
});

// ---- Tool 1: note_create ----

server.tool(
  "note_create",
  "Create a new scratch pad note on the desktop. Supports markdown content. The note appears as a floating window the user can see. Do not repeat the title in the body — the title is displayed separately above the body. Set scope to share the note with peers on the network.",
  {
    body: z.string().describe("The note content (do not include the title here — it is shown separately)"),
    title: z.string().optional().describe("Optional note title (displayed separately above the body)"),
    color: z
      .enum(["yellow", "pink", "blue", "green"])
      .optional()
      .default("yellow")
      .describe("Note color (default: yellow)"),
    ttl: z
      .number()
      .optional()
      .describe("Hours until the note auto-expires"),
    scope: z
      .enum(["local", "team"])
      .or(z.string())
      .optional()
      .default("local")
      .describe("Sharing scope: 'local' (default, no sharing), 'team' (share with all peers), or a named group"),
    intent: z
      .enum(["decision", "question", "context", "handoff", "fyi"])
      .optional()
      .default("fyi")
      .describe("Note intent when sharing (default: fyi)"),
  },
  async ({ body, title, color, ttl, scope, intent }) => {
    const now = new Date();
    const note: Note = {
      id: crypto.randomUUID(),
      title: title ?? null,
      body,
      color: color ?? "yellow",
      createdAt: now.toISOString(),
      expiresAt: ttl != null
        ? new Date(now.getTime() + ttl * 60 * 60 * 1000).toISOString()
        : null,
      position: null,
      size: null,
    };

    const notes = readNotes();
    notes.push(note);
    writeNotes(notes);

    if (scope !== "local") {
      writeSignalFile(`.share-${note.id}`, { scope, intent });
    }

    const shared = scope !== "local" ? ` | Shared to ${scope} [${intent}]` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Created note ${note.id}${note.title ? ` ("${note.title}")` : ""} [${note.color}]${shared}`,
        },
      ],
    };
  },
);

// ---- Tool 2: note_list ----

server.tool(
  "note_list",
  "List all active scratch pad notes (local and network) with their full content",
  {},
  async () => {
    const notes = readNotes();
    const now = Date.now();

    const active = notes.filter(
      (n) => !n.expiresAt || new Date(n.expiresAt).getTime() > now,
    );

    // Write back if we pruned any expired notes
    if (active.length !== notes.length) {
      writeNotes(active);
    }

    let text = "";

    if (active.length === 0) {
      text = "No active local notes.";
    } else {
      const lines = active.map((n) => {
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
      });

      text = `${active.length} active note(s):\n\n${lines.join("\n\n---\n\n")}`;
    }

    const remoteNotes = readRemoteNotes();

    if (remoteNotes.length > 0) {
      text += `\n\n## Network Notes (${remoteNotes.length})\n\n`;
      for (const rn of remoteNotes) {
        const age = formatAge(rn.timestamp);
        text += `### [${rn.intent}] from ${rn.sender} (${age})\n`;
        if (rn.title) text += `**${rn.title}**\n`;
        text += `${rn.body}\n`;
        text += `ID: ${rn.id} | Scope: ${rn.scope} | TTL: ${rn.ttl === 0 ? "session" : rn.ttl + "s"}\n\n`;
      }
    } else {
      text += `\n\n## Network Notes\n\nNo network notes available.`;
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  },
);

// ---- Tool 3: note_read ----

server.tool(
  "note_read",
  "Read the full content of a specific scratch pad note by ID",
  {
    id: z.string().describe("The ID of the note to read"),
  },
  async ({ id }) => {
    const notes = readNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) {
      // Check remote notes before giving up
      const remoteNotes = readRemoteNotes();
      const remoteNote = remoteNotes.find((n) => n.id === id);
      if (remoteNote) {
        let text = "";
        if (remoteNote.title) text += `# ${remoteNote.title}\n\n`;
        text += remoteNote.body;
        text += `\n\n---\nFrom: ${remoteNote.sender} | Intent: ${remoteNote.intent} | Scope: ${remoteNote.scope}`;
        text += `\nReceived: ${formatAge(remoteNote.timestamp)} | TTL: ${remoteNote.ttl === 0 ? "session" : remoteNote.ttl + "s"}`;
        text += `\nID: ${remoteNote.id}`;
        return { content: [{ type: "text" as const, text }] };
      }

      return {
        content: [{ type: "text" as const, text: `Note ${id} not found.` }],
      };
    }
    const titleLine = note.title ? `# ${note.title}\n\n` : "";
    const meta = `[${note.color}] Created: ${new Date(note.createdAt).toLocaleString()}`;
    const expires = note.expiresAt ? ` | Expires: ${new Date(note.expiresAt).toLocaleString()}` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `${titleLine}${note.body}\n\n---\n${meta}${expires}\nID: ${note.id}`,
        },
      ],
    };
  },
);

// ---- Tool 4: note_update ----

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
  async ({ id, body, title, color }) => {
    const notes = readNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) {
      return {
        content: [{ type: "text" as const, text: `Note ${id} not found.` }],
      };
    }

    if (body !== undefined) note.body = body;
    if (title !== undefined) note.title = title;
    if (color !== undefined) note.color = color;

    writeNotes(notes);
    return {
      content: [
        {
          type: "text" as const,
          text: `Updated note ${note.id}${note.title ? ` ("${note.title}")` : ""}`,
        },
      ],
    };
  },
);

// ---- Tool 5: note_move ----

server.tool(
  "note_move",
  "Move a scratch pad note to a specific screen position",
  {
    id: z.string().describe("The ID of the note to move"),
    x: z.number().describe("X position in screen pixels"),
    y: z.number().describe("Y position in screen pixels"),
  },
  async ({ id, x, y }) => {
    const notes = readNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) {
      return {
        content: [{ type: "text" as const, text: `Note ${id} not found.` }],
      };
    }

    note.position = { x, y };
    writeNotes(notes);
    return {
      content: [
        {
          type: "text" as const,
          text: `Moved note ${note.id} to (${x}, ${y})`,
        },
      ],
    };
  },
);

// ---- Tool 6: note_resize ----

server.tool(
  "note_resize",
  "Resize a scratch pad note window",
  {
    id: z.string().describe("The ID of the note to resize"),
    width: z.number().describe("Width in pixels"),
    height: z.number().describe("Height in pixels"),
  },
  async ({ id, width, height }) => {
    const notes = readNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) {
      return {
        content: [{ type: "text" as const, text: `Note ${id} not found.` }],
      };
    }

    note.size = { width, height };
    writeNotes(notes);
    return {
      content: [
        {
          type: "text" as const,
          text: `Resized note ${note.id} to ${width}x${height}`,
        },
      ],
    };
  },
);

// ---- Tool 7: note_organize ----

server.tool(
  "note_organize",
  "Arrange all scratch pad notes in an optimal grid layout filling the screen. The app handles the actual layout using real screen dimensions.",
  {},
  async () => {
    const notes = readNotes();
    const active = notes.filter(
      (n) => !n.expiresAt || new Date(n.expiresAt).getTime() > Date.now(),
    );

    if (active.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No notes to organize." }],
      };
    }

    // Write a signal file — the app's file watcher picks it up and runs
    // organize_windows with real screen dimensions
    fs.writeFileSync(path.join(notesDir(), ".organize"), "", "utf-8");

    return {
      content: [
        {
          type: "text" as const,
          text: `Organizing ${active.length} note(s)`,
        },
      ],
    };
  },
);

// ---- Tool 8: note_clear ----

server.tool(
  "note_clear",
  "Dismiss/delete one or all scratch pad notes",
  {
    id: z
      .string()
      .optional()
      .describe("ID of a specific note to dismiss. Omit to clear ALL notes."),
  },
  async ({ id }) => {
    if (id) {
      const notes = readNotes();
      const before = notes.length;
      const remaining = notes.filter((n) => n.id !== id);

      if (remaining.length === before) {
        return {
          content: [
            { type: "text" as const, text: `Note ${id} not found.` },
          ],
        };
      }

      writeNotes(remaining);
      writeSignalFile(`.retract-${id}`);
      return {
        content: [
          { type: "text" as const, text: `Dismissed note ${id}.` },
        ],
      };
    }

    // Clear all — retract each note from the network before clearing
    const notes = readNotes();
    for (const note of notes) {
      writeSignalFile(`.retract-${note.id}`);
    }
    writeNotes([]);
    return {
      content: [
        { type: "text" as const, text: "All notes cleared." },
      ],
    };
  },
);

// ---- Tool 9: peer_discover ----

server.tool(
  "peer_discover",
  "Find active Scratch Pad instances on the local network. Returns discovered peers.",
  {},
  async () => {
    const peers = readPeers();
    if (peers.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No peers discovered on the network. Make sure other Scratch Pad instances are running on the same LAN.",
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

// ---- Tool 10: peer_list ----

server.tool(
  "peer_list",
  "List currently connected peers with their status and shared note counts.",
  {},
  async () => {
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
      text += `- **${peer.name}** — ${noteCount} shared note${noteCount !== 1 ? "s" : ""}\n`;
      text += `  Last seen: ${peer.lastSeen}\n`;
    }
    return { content: [{ type: "text" as const, text }] };
  },
);

// ---- Tool 11: pad_subscribe ----

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
      if (!subs.includes(scope)) {
        subs.push(scope);
      }
      fs.writeFileSync(
        subsFile,
        JSON.stringify(subs, null, 2) + "\n",
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

    // No scope = subscribe to all (delete subs file)
    if (fs.existsSync(subsFile)) fs.unlinkSync(subsFile);
    return {
      content: [
        {
          type: "text" as const,
          text: "Subscribed to all scopes (no filtering).",
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
