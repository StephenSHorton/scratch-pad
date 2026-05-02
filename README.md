# Aizuchi

**Live mind-map meetings — an AI that listens alongside you.**

Aizuchi is a desktop meeting tool. As you talk, an AI builds a live mind-map of the conversation — questions, decisions, action items, open threads. The mind-map is how the AI shows it's following. Everyone in the meeting can see, correct, and extend the shared understanding in real time.

The name comes from the Japanese word *aizuchi* — the listener's backchanneling ("I see," "right," "uh huh") that signals "I'm following you." That's what the AI does, except instead of nodding, it draws.

## Status

Early. Building in public. The repo also hosts **Scratch Pad** — a sticky-notes feature that runs in the same app and shares the same persistence layer and MCP server. Both are local-first.

## Install

1. Download the latest `.dmg` from the [Releases](https://github.com/StephenSHorton/aizuchi/releases) page
2. Open the DMG and drag Aizuchi to Applications
3. Run this command to remove the macOS quarantine flag:

```bash
xattr -cr /Applications/Aizuchi.app
```

4. Open Aizuchi from Applications

### Why do I need the xattr command?

macOS quarantines apps that aren't signed with an Apple Developer certificate. Aizuchi is not yet code-signed, so macOS will show a "damaged" warning and refuse to open it. The `xattr -cr` command removes the quarantine attribute. This is safe — you can verify the source code in this repo. Apple Developer code signing is planned for a future release.

## MCP setup for Claude Code

After installing, connect Claude Code to the bundled MCP server:

```bash
claude mcp add --transport stdio --scope user aizuchi -- "/Applications/Aizuchi.app/Contents/MacOS/aizuchi-mcp"
```

Restart Claude Code. You'll have tools for scratch pad notes, meetings, multiplayer, and logs.

### Scratch pad tools (selection)

| Tool | Description |
| --- | --- |
| `note_create` | Create a scratch pad note (markdown, optional `scope` for sharing) |
| `note_list` | List all local and network scratch pads |
| `note_read` | Read a specific scratch pad |
| `note_update` | Update content, title, or color |
| `note_organize` | Arrange all scratch pads in a grid |
| `peer_discover` | Find other Aizuchi instances on your network |
| `peer_list` | List connected peers |
| `meeting_start` | Start a live mind-map meeting |
| `meeting_list` | List past meetings |

Just talk naturally to Claude:

- "Write that to a scratch pad"
- "Start a meeting"
- "What's on my scratch pads?"
- "Share that decision with the team"

## Multiplayer

Aizuchi instances on the same local network discover each other automatically via mDNS (`_aizuchi._tcp.local.`) and can share notes in real-time over TCP. No configuration needed — just have team members run the app.

**Scopes** control who sees a note: `local` (default, only you), `team` (everyone on the network).

**Intents** hint at what the note is about: `decision`, `question`, `context`, `handoff`, `fyi`.

## Development

```bash
bun install
cd mcp-server && bun install
bun tauri dev
```

The sidecar binary must exist for `tauri dev` to work:
```bash
bun run build:mcp
```

## Tech stack

Tauri v2, React 19, Vite, Tailwind v4, TypeScript, Rust.

## License

MIT.
