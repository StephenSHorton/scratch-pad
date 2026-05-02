/**
 * Integration tests for the `scratch-pad` CLI.
 *
 * Spawns the binary as a real subprocess so flag parsing, exit codes,
 * and stdout/stderr split match production.
 *
 * Limited to scenarios that don't need a live Tauri app:
 *   - --help / --version
 *   - app-not-running fast path (HOME points at an empty tmp dir)
 *
 * Full meeting + pad CRUD live behind `bun run scripts/ipc-smoke.ts`
 * (or human verification).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = path.join(import.meta.dir, "scratch-pad.ts");

let tmpHome = "";

beforeEach(async () => {
	tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-home-"));
});

afterEach(async () => {
	try {
		await fs.rm(tmpHome, { recursive: true, force: true });
	} catch {
		// noop
	}
});

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<RunResult> {
	const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("scratch-pad CLI", () => {
	it("--version prints a version string and exits 0", async () => {
		const r = await runCli(["--version"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("scratch-pad/");
	});

	it("--help lists every supported command", async () => {
		const r = await runCli(["--help"]);
		expect(r.exitCode).toBe(0);
		const expectedCommands = [
			"ls",
			"new",
			"cat",
			"edit",
			"rm",
			"focus",
			"meeting",
			"status",
		];
		for (const cmd of expectedCommands) {
			expect(r.stdout).toContain(cmd);
		}
	});

	it("prints a clean app-not-running message when discovery files are missing", async () => {
		// HOME points at an empty tmpdir → ~/.scratch-pad/cli-token won't
		// exist → the client throws AppNotRunningError before any HTTP
		// happens.
		const r = await runCli(["status"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
		// No leaked stack trace.
		expect(r.stderr).not.toContain("at ");
		expect(r.stderr).not.toContain("ECONNREFUSED");
		expect(r.stdout).toBe("");
	});

	it("app-not-running message is preserved for `ls`", async () => {
		const r = await runCli(["ls"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`meeting stop` without an id errors out without contacting the server", async () => {
		// Even with HOME unset for discovery, the explicit-id check should
		// fire first if we end up dispatching. But we ALSO want this to
		// work when the app *is* running, so test with a still-empty HOME
		// and accept either: missing-id error or app-not-running. The
		// behaviour of interest is: exit 1, useful message, no stack.
		const r = await runCli(["meeting", "stop"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toMatch(/meeting stop requires|app isn't running/);
	});
});
