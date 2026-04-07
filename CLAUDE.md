# Scratch Pad

Desktop sticky notes app (Tauri v2) + MCP server for Claude Code.

## Architecture

- **Tauri app** (`src-tauri/`) — Rust backend, manages windows, file watching, system tray, auto-updater, P2P networking
- **Frontend** (`src/`) — React 19, Tailwind v4, Vite 8, TanStack Router
- **MCP server** (`mcp-server/`) — TypeScript stdio server with 8 tools for notes + 3 tools for multiplayer
- **P2P networking** (`src-tauri/src/network/`) — mDNS discovery + TCP transport for LAN-based note sharing
- **Shared contract** — `~/.scratch-pad/notes.json` (local notes), `~/.scratch-pad/remote-notes.json` (peer notes), `~/.scratch-pad/peers.json` (connected peers)

## Development

```bash
bun install                  # Frontend deps
cd mcp-server && bun install # MCP server deps
bun tauri dev                # Run the app in dev mode
```

The sidecar binary must exist for `tauri dev` to work:
```bash
bun run build:mcp            # Builds MCP sidecar to src-tauri/binaries/
```

## Releasing

**Important:** Bump the version in `src-tauri/tauri.conf.json` before tagging. The version in this file determines the DMG filename and the auto-updater version comparison.

```bash
# 1. Bump version in src-tauri/tauri.conf.json
# 2. Commit
# 3. Tag and push
git tag v0.X.0
git push origin main --tags
# 4. Wait for GitHub Actions to build (~7 min: build + updater signing)
# 5. Publish the draft release on GitHub
gh release edit v0.X.0 --draft=false
```

The release workflow:
1. Builds DMGs for macOS ARM + Intel (parallel jobs)
2. Compiles the MCP sidecar binary for each architecture
3. Signs the `.app.tar.gz` bundles in a separate `updater` job
4. Generates and uploads `latest.json` with signatures for auto-updates
5. Creates a draft GitHub Release

## Code style

- **Rust** — Standard rustfmt
- **TypeScript** — Biome: tabs, double quotes
- **Commits** — Imperative mood, include `Co-Authored-By` for Claude

## Key files

- `src-tauri/tauri.conf.json` — App config, version, bundle settings, updater pubkey
- `src-tauri/src/lib.rs` — Core Rust logic (commands, window management, tray, file watcher, updater)
- `src-tauri/src/network/` — P2P networking module (discovery, transport, protocol, store)
- `src/routes/index.tsx` — Sticky note React component (markdown rendering, editing, color picker, remote note display)
- `src/index.css` — Markdown rendering styles (`.md-body` classes)
- `mcp-server/src/index.ts` — MCP server implementation (local + multiplayer tools)
- `.github/workflows/release.yml` — CI/CD for building and publishing releases
- `src-tauri/icons/tray-icon.png` — System tray icon (embedded at compile time via `include_bytes!`)

## MCP server

The MCP sidecar binary is bundled inside the app at `Scratch Pad.app/Contents/MacOS/scratch-pad-mcp`. Users configure Claude Code to point to it:

```bash
claude mcp add --transport stdio --scope user scratch-pad -- "/Applications/Scratch Pad.app/Contents/MacOS/scratch-pad-mcp"
```

To rebuild the sidecar locally:
```bash
bun run build:mcp
```

## Multiplayer (P2P Networking)

Scratch Pad instances on the same LAN automatically discover each other via mDNS and can share notes in real-time over TCP. This enables a **Decentralized Claude Network** where Claude Code instances share context, decisions, and updates without a central server.

### How it works

1. Each running Scratch Pad app registers itself on the local network via mDNS (`_scratchpad._tcp.local.`)
2. Peers discover each other automatically — no configuration needed
3. Notes created with a `scope` other than `"local"` get broadcast to all connected peers
4. Remote notes appear as read-only floating stickies with sender attribution
5. Everything is ephemeral — remote notes evaporate when sessions end

### Data flow

```
Claude Code --MCP--> note_create(scope: "team") --> notes.json + .share-{id} signal
Tauri file watcher picks up signal --> wraps note in envelope --> broadcasts via TCP
Peer receives --> stores in memory --> writes remote-notes.json --> creates window
```

### Filesystem contract

| File | Purpose | Written by |
|------|---------|------------|
| `~/.scratch-pad/notes.json` | Local notes | Tauri app + MCP server |
| `~/.scratch-pad/remote-notes.json` | Notes from peers | Tauri app (network module) |
| `~/.scratch-pad/peers.json` | Connected peers | Tauri app (network module) |
| `~/.scratch-pad/subscriptions.json` | Scope filter prefs | MCP server (`pad_subscribe`) |
| `~/.scratch-pad/.share-{noteId}` | Signal: share a note | MCP server (transient) |
| `~/.scratch-pad/.retract-{noteId}` | Signal: retract a note | MCP server (transient) |

### Network module structure (`src-tauri/src/network/`)

- `protocol.rs` — Wire types: `NoteEnvelope`, `NoteScope`, `NoteIntent`, `Message` (Hello/Note/Retract/Heartbeat/Sync), `PeerInfo`
- `discovery.rs` — mDNS registration and browsing via `mdns-sd` crate
- `transport.rs` — TCP listener/client with length-prefixed JSON framing, heartbeat, dedup, reconnect
- `store.rs` — In-memory remote note store with TTL sweep, capacity limits, disk sync
- `mod.rs` — `NetworkHandle` API and `start_network()` orchestrator

### Design constraints

- **Ephemeral:** Remote notes live in memory only. Nothing persists across restarts.
- **No auth:** Scoping (`team`, named groups) is for relevance routing, not security. LAN-only.
- **No gossip:** Direct peer connections only. Practical for teams up to ~20.
- **Graceful degradation:** If mDNS or TCP fails, local notes work normally.

## Signing

- **Updater signing** — Uses a minisign keypair. Private key at `~/.tauri/scratch-pad.key`, public key in `tauri.conf.json`. GitHub secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Apple code signing** — Not yet configured. App is currently unsigned, requiring users to run `xattr -cr` after install.

## Known issues

- macOS quarantines the app on first install (unsigned). Workaround: `xattr -cr /Applications/Scratch\ Pad.app`
- Auto-updater may also be affected by quarantine on the downloaded update binary
