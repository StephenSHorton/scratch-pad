# Scratch Pad

**Desktop scratch pads for Claude Code**

Floating desktop notes that Claude can create, read, update, and delete via MCP.

## Features

- Floating borderless notes on your desktop
- Markdown rendering (headers, code blocks, lists, bold/italic)
- Editable -- double-click to edit title or body
- Color themes (yellow, pink, blue, green)
- MCP server with 5 tools for Claude Code integration
- Auto-updates via GitHub Releases
- System tray icon
- Launch on login

## Install

1. Download the latest `.dmg` from the [Releases](https://github.com/stephenhorton/scratch-pad/releases) page
2. Drag to Applications
3. On first launch, if macOS says "damaged", run:

```bash
xattr -cr /Applications/Scratch\ Pad.app
```

## MCP Setup for Claude Code

After installing, connect Claude Code to the bundled MCP server:

```bash
claude mcp add --transport stdio --scope user scratch-pad -- "/Applications/Scratch Pad.app/Contents/MacOS/scratch-pad-mcp"
```

Then restart Claude Code. You'll have these tools available:

| Tool | Description |
| --- | --- |
| `note_create` | Create a scratch pad (supports markdown) |
| `note_list` | List all active scratch pads |
| `note_read` | Read a specific scratch pad |
| `note_update` | Update a scratch pad's content, title, or color |
| `note_clear` | Delete one or all scratch pads |

### Usage examples

Just talk naturally:

- "Write that to a scratch pad"
- "Open a scratch pad and note down our plan"
- "What's on my scratch pads?"
- "Delete that last scratch pad"
- "Update the scratch pad with the new approach"

## Development

```bash
bun install
cd mcp-server && bun install
bun tauri dev
```

## Tech Stack

Tauri v2, React 19, Vite 8, Tailwind v4, TypeScript, Rust

## License

MIT
