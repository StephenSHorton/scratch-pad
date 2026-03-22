# Scratch Pad

Desktop sticky notes app (Tauri v2) + MCP server for Claude Code.

## Architecture

- **Tauri app** (`src-tauri/`) — Rust backend, manages windows, file watching, system tray, auto-updater
- **Frontend** (`src/`) — React 19, Tailwind v4, Vite 8, TanStack Router
- **MCP server** (`mcp-server/`) — TypeScript stdio server with 5 tools: `note_create`, `note_list`, `note_read`, `note_update`, `note_clear`
- **Shared contract** — `~/.scratch-pad/notes.json` (both app and MCP server read/write this file)

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
- `src-tauri/src/lib.rs` — All Rust logic (commands, window management, tray, file watcher, updater)
- `src/routes/index.tsx` — Sticky note React component (markdown rendering, editing, color picker)
- `src/index.css` — Markdown rendering styles (`.md-body` classes)
- `mcp-server/src/index.ts` — MCP server implementation
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

## Signing

- **Updater signing** — Uses a minisign keypair. Private key at `~/.tauri/scratch-pad.key`, public key in `tauri.conf.json`. GitHub secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Apple code signing** — Not yet configured. App is currently unsigned, requiring users to run `xattr -cr` after install.

## Known issues

- macOS quarantines the app on first install (unsigned). Workaround: `xattr -cr /Applications/Scratch\ Pad.app`
- Auto-updater may also be affected by quarantine on the downloaded update binary
