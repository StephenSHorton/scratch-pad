# Scratch Pad

**Desktop scratch pads for Claude Code**

Floating desktop notes that Claude can create, read, update, and delete via MCP.

## Features

- Floating borderless notes on your desktop
- Markdown rendering (headers, code blocks, lists, bold/italic)
- Editable -- double-click to edit title or body
- Color themes (yellow, pink, blue, green)
- MCP server with 11 tools for Claude Code integration
- **Multiplayer** -- P2P note sharing between team members on the same LAN
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
| `note_create` | Create a scratch pad (supports markdown, optional `scope` and `intent` for sharing) |
| `note_list` | List all local and network scratch pads |
| `note_read` | Read a specific scratch pad (local or remote) |
| `note_update` | Update a scratch pad's content, title, or color |
| `note_clear` | Delete one or all scratch pads (retracts shared notes from network) |
| `note_move` | Reposition a scratch pad on screen |
| `note_resize` | Change a scratch pad's dimensions |
| `note_organize` | Arrange all scratch pads in a grid layout |
| `peer_discover` | Find other Scratch Pad instances on your network |
| `peer_list` | List connected peers and their shared note counts |
| `pad_subscribe` | Filter which network notes you receive by scope |

### Usage examples

Just talk naturally:

- "Write that to a scratch pad"
- "Open a scratch pad and note down our plan"
- "What's on my scratch pads?"
- "Delete that last scratch pad"
- "Update the scratch pad with the new approach"
- "Share that decision with the team"
- "Who else is on the network?"
- "What has the team shared?"

## Multiplayer

Scratch Pad instances on the same local network automatically discover each other and can share notes in real-time. No configuration needed -- just have team members run Scratch Pad.

### How it works

1. Open Scratch Pad on multiple machines on the same LAN
2. Peers discover each other automatically via mDNS
3. Share a note by creating it with a scope:
   - Tell Claude: *"Share that decision with the team"*
   - Or programmatically: `note_create` with `scope: "team"` and `intent: "decision"`
4. Shared notes appear on teammates' desktops as read-only stickies with sender attribution
5. Notes are ephemeral -- they disappear when the sharing app closes

### Scopes and intents

**Scopes** control who sees the note:
- `local` (default) -- only you
- `team` -- everyone on the network

**Intents** hint at what the note is about:
- `decision` -- architectural or design decisions
- `question` -- something you need input on
- `context` -- background info (what you're working on, blockers)
- `handoff` -- passing work to someone else
- `fyi` -- general awareness

### Example workflows

**Senior/Junior context sharing:** A senior dev's Claude reasons through an architecture decision, shares it with `intent: "decision"`. The junior dev's Claude picks it up and is immediately aligned on the *why*, not just the *what*.

**Parallel sprint:** Two devs working frontend and backend. Backend Claude posts an interface contract. Frontend Claude picks it up and adapts in real time.

**Ambient awareness:** Claude auto-posts "currently working on payment module" as `intent: "context"`. Team has passive situational awareness without any meetings.

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
