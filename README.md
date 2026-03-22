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

1. Download the latest `.dmg` from the [Releases](https://github.com/StephenSHorton/scratch-pad/releases) page
2. Open the DMG and drag Scratch Pad to Applications
3. Run this command to remove the macOS quarantine flag:

```bash
xattr -cr /Applications/Scratch\ Pad.app
```

4. Open Scratch Pad from Applications

### Why do I need the xattr command?

macOS quarantines apps that aren't signed with an Apple Developer certificate. Since Scratch Pad is not yet code-signed, macOS will show a "damaged" warning and refuse to open it. The `xattr -cr` command removes the quarantine attribute so macOS allows the app to run. This is safe -- you can verify the source code in this repo. Apple Developer code signing is planned for a future release.

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
