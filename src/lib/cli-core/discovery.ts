/**
 * Discovery + auth: read the bound port and bearer token from
 * `~/.scratch-pad/`, verify the token file's perms, and return a config
 * a caller can hand to `fetch`.
 *
 * Mirrors the server-side contract in
 * `src-tauri/src/cli_server/auth.rs` and `discovery.rs`. Both files are
 * mode 0600 on disk; the token file in particular is sensitive — anyone
 * who can read it can call every authenticated endpoint, so we refuse
 * to use it if the perms have been loosened.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppNotRunningError, IpcClientError, TokenPermsError } from "./errors";
import type { IpcConfig } from "./types";

/** `~/.scratch-pad/` — the canonical location for the discovery files. */
export function defaultBaseDir(): string {
	return path.join(os.homedir(), ".scratch-pad");
}

const TOKEN_FILENAME = "cli-token";
const PORT_FILENAME = "cli.port";

/**
 * Read + verify the discovery files. Throws a typed error class for
 * every recoverable failure mode.
 *
 * @param baseDir Override `~/.scratch-pad/`. Defaults to the user's
 * home dir; tests pass a temp dir.
 */
export async function loadIpcConfig(baseDir?: string): Promise<IpcConfig> {
	const dir = baseDir ?? defaultBaseDir();
	const tokenPath = path.join(dir, TOKEN_FILENAME);
	const portPath = path.join(dir, PORT_FILENAME);

	const token = await readToken(tokenPath, dir);
	const port = await readPort(portPath);

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		token,
	};
}

async function readToken(tokenPath: string, baseDir: string): Promise<string> {
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(tokenPath);
	} catch (err) {
		if (isErrnoCode(err, "ENOENT")) {
			throw new AppNotRunningError(
				`Token file not found at ${tokenPath}. Is the Scratch Pad app running?`,
			);
		}
		throw new IpcClientError(
			"discovery_error",
			`Failed to stat token file ${tokenPath}: ${describeError(err)}`,
			err,
		);
	}

	// Symlink-swap defense: realpath the token, assert it's still inside
	// `~/.scratch-pad/`. Refuses to read a token that's been redirected
	// to (e.g.) `/tmp/attacker-token`.
	const resolvedDir = await fs.realpath(baseDir);
	const resolvedToken = await fs.realpath(tokenPath);
	if (!isPathInside(resolvedToken, resolvedDir)) {
		throw new TokenPermsError(
			`Token path resolves outside the scratch-pad dir (got ${resolvedToken}). Refusing to read.`,
		);
	}

	// On Unix, refuse to read a token file that's group- or world-readable.
	// On Windows the mode bits aren't faithful, so skip the check.
	if (process.platform !== "win32") {
		const mode = stat.mode & 0o777;
		if ((mode & 0o077) !== 0) {
			throw new TokenPermsError(
				`Token file ${tokenPath} has insecure mode ${mode.toString(8).padStart(4, "0")}. ` +
					`Run \`chmod 600 ${tokenPath}\` and try again.`,
			);
		}
	}

	const raw = await fs.readFile(tokenPath, "utf-8");
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new IpcClientError(
			"discovery_error",
			`Token file ${tokenPath} is empty. Restart the Scratch Pad app.`,
		);
	}
	return trimmed;
}

async function readPort(portPath: string): Promise<number> {
	let raw: string;
	try {
		raw = await fs.readFile(portPath, "utf-8");
	} catch (err) {
		if (isErrnoCode(err, "ENOENT")) {
			throw new AppNotRunningError(
				`Port file not found at ${portPath}. Is the Scratch Pad app running?`,
			);
		}
		throw new IpcClientError(
			"discovery_error",
			`Failed to read port file ${portPath}: ${describeError(err)}`,
			err,
		);
	}
	const port = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new IpcClientError(
			"discovery_error",
			`Port file ${portPath} is malformed (got ${JSON.stringify(raw.trim())}).`,
		);
	}
	return port;
}

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isErrnoCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === code
	);
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
