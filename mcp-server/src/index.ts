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
  "Create a new scratch pad note on the desktop. Supports markdown content. The note appears as a floating window the user can see. Do not repeat the title in the body — the title is displayed separately above the body.",
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
      size: null,
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
      if (n.position) {
        parts.push(`Position: (${n.position.x}, ${n.position.y})`);
      }
      if (n.size) {
        parts.push(`Size: ${n.size.width}x${n.size.height}`);
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
