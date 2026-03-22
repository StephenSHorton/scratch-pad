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
}

function notesDir(): string {
  return path.join(os.homedir(), ".scratch-pad");
}

function notesFile(): string {
  return path.join(notesDir(), "notes.json");
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
  "Create a new scratch pad note on the desktop. Supports markdown content. The note appears as a floating window the user can see.",
  {
    body: z.string().describe("The note content"),
    title: z.string().optional().describe("Optional note title"),
    color: z
      .enum(["yellow", "pink", "blue", "green"])
      .optional()
      .default("yellow")
      .describe("Note color (default: yellow)"),
    ttl: z
      .number()
      .optional()
      .describe("Hours until the note auto-expires"),
  },
  async ({ body, title, color, ttl }) => {
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
    };

    const notes = readNotes();
    notes.push(note);
    writeNotes(notes);

    return {
      content: [
        {
          type: "text" as const,
          text: `Created note ${note.id}${note.title ? ` ("${note.title}")` : ""} [${note.color}]`,
        },
      ],
    };
  },
);

// ---- Tool 2: note_list ----

server.tool(
  "note_list",
  "List all active scratch pad notes with their full content",
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

    if (active.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No active notes." }],
      };
    }

    const lines = active.map((n) => {
      const parts = [`## ${n.title || "(untitled)"} [${n.color}]`, `ID: ${n.id}`];
      parts.push(`Created: ${new Date(n.createdAt).toLocaleString()}`);
      if (n.expiresAt) {
        parts.push(`Expires: ${new Date(n.expiresAt).toLocaleString()}`);
      }
      parts.push("", n.body);
      return parts.join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `${active.length} active note(s):\n\n${lines.join("\n\n---\n\n")}`,
        },
      ],
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

// ---- Tool 5: note_clear ----

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
      return {
        content: [
          { type: "text" as const, text: `Dismissed note ${id}.` },
        ],
      };
    }

    // Clear all
    writeNotes([]);
    return {
      content: [
        { type: "text" as const, text: "All notes cleared." },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
