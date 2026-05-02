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
			"pad",
			"meeting",
			"status",
		];
		for (const cmd of expectedCommands) {
			expect(r.stdout).toContain(cmd);
		}
	});

	it("ls --help mentions --include-hidden and --only-hidden", async () => {
		const r = await runCli(["ls", "--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("--include-hidden");
		expect(r.stdout).toContain("--only-hidden");
	});

	it("top-level --help advertises the meeting subcommands", async () => {
		const r = await runCli(["--help"]);
		expect(r.exitCode).toBe(0);
		// The meeting command's brief description enumerates the
		// supported subcommands so they're visible from `--help`.
		expect(r.stdout).toContain("resume");
		expect(r.stdout).toContain("rename");
	});

	it("top-level --help advertises the pad visibility subcommands", async () => {
		const r = await runCli(["--help"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("hide");
		expect(r.stdout).toContain("show-hidden");
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

	// ---- pad subcommand group ------------------------------------------

	it("`pad hide <id>` prints app-not-running when the app is down", async () => {
		const r = await runCli(["pad", "hide", "abc"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
		expect(r.stderr).not.toContain("at ");
	});

	it("`pad show <id>` prints app-not-running when the app is down", async () => {
		const r = await runCli(["pad", "show", "abc"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`pad show-hidden` prints app-not-running when the app is down", async () => {
		const r = await runCli(["pad", "show-hidden"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`pad hide` without an id errors out before discovery", async () => {
		const r = await runCli(["pad", "hide"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("pad hide requires the pad id");
	});

	it("`pad show` without an id errors out before discovery", async () => {
		const r = await runCli(["pad", "show"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("pad show requires the pad id");
	});

	it("unknown `pad` subcommand exits 2 with a useful message", async () => {
		const r = await runCli(["pad", "wat"], { HOME: tmpHome });
		expect(r.exitCode).toBe(2);
		expect(r.stderr).toContain("unknown pad subcommand");
	});

	// ---- meeting extended commands ------------------------------------

	it("`meeting resume <id>` prints app-not-running when the app is down", async () => {
		const r = await runCli(["meeting", "resume", "m-1"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`meeting rm <id>` prints app-not-running when the app is down", async () => {
		const r = await runCli(["meeting", "rm", "m-1"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`meeting rename <id> <name>` prints app-not-running when the app is down", async () => {
		const r = await runCli(["meeting", "rename", "m-1", "New name"], {
			HOME: tmpHome,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("app isn't running");
	});

	it("`meeting resume` without an id errors out before discovery", async () => {
		const r = await runCli(["meeting", "resume"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("meeting resume requires the meeting id");
	});

	it("`meeting rm` without an id errors out before discovery", async () => {
		const r = await runCli(["meeting", "rm"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("meeting rm requires the meeting id");
	});

	it("`meeting rename` without an id errors out before discovery", async () => {
		const r = await runCli(["meeting", "rename"], { HOME: tmpHome });
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("meeting rename requires the meeting id");
	});

	it("`meeting rename <id> ''` rejects empty names with a clear message", async () => {
		const r = await runCli(["meeting", "rename", "m-1", ""], {
			HOME: tmpHome,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("meeting rename requires a non-empty name");
		// Should fail before the discovery step.
		expect(r.stderr).not.toContain("app isn't running");
	});
});
