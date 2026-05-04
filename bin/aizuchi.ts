#!/usr/bin/env bun
/**
 * `aizuchi` — base CLI for the Aizuchi desktop app.
 *
 * Phase 3 of AIZ-13. Wraps the typed IPC client at `src/lib/cli-core/`
 * with a friendly command surface. The full method surface is exposed
 * by the client; this binary only reaches for the subset listed in
 * AIZ-21. The "extended" CLI (AIZ-22) and MCP refactor (AIZ-23) layer
 * additional UX on top of the same client.
 *
 * Output rules:
 *   --json          Emit canonical JSON (the IPC server response shape).
 *   NO_COLOR=1      Strip ANSI codes regardless of TTY.
 *   non-TTY pipes   Plain, tab-separated rows (no headers).
 *
 * Errors:
 *   AppNotRunning   Friendly one-liner. Exit 1.
 *   Other           "aizuchi: <message>" to stderr. Exit 1.
 *   --debug         Also print the stack trace.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { cac } from "cac";

import {
	AizuchiClient,
	AppNotRunningError,
	IpcClientError,
	type MeetingMeta,
	type Note,
	NotFoundError,
} from "../src/lib/cli-core";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
};

function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	return Boolean(process.stdout.isTTY);
}

function dim(s: string): string {
	return colorEnabled() ? `${ANSI.dim}${s}${ANSI.reset}` : s;
}

function bold(s: string): string {
	return colorEnabled() ? `${ANSI.bold}${s}${ANSI.reset}` : s;
}

function isTTY(): boolean {
	return Boolean(process.stdout.isTTY);
}

function emitJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

interface GlobalFlags {
	debug?: boolean;
}

function fatal(err: unknown, flags: GlobalFlags): never {
	if (err instanceof AppNotRunningError) {
		process.stderr.write(
			"aizuchi: app isn't running. Start it with `open -a 'Aizuchi'` or run `bun tauri dev` from the repo.\n",
		);
		process.exit(1);
	}
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`aizuchi: ${message}\n`);
	if (flags.debug && err instanceof Error && err.stack) {
		process.stderr.write(`${err.stack}\n`);
	}
	process.exit(1);
}

// Reads the parent CLI's parsed --json/--debug. cac merges these into
// every subcommand's options object via `globalCommand`.
function readFlags(opts: Record<string, unknown>): {
	json: boolean;
	debug: boolean;
} {
	return {
		json: opts.json === true,
		debug: opts.debug === true,
	};
}

// ---------------------------------------------------------------------------
// Pad rendering
// ---------------------------------------------------------------------------

function formatPadRow(note: Note): string {
	const id = note.id;
	const title = (note.title ?? "").replace(/\s+/g, " ").slice(0, 40);
	const color = note.color;
	const hidden = note.hidden ? "yes" : "no";
	const updatedAt = note.createdAt;
	if (isTTY()) {
		return [
			id.padEnd(36),
			title.padEnd(40),
			color.padEnd(8),
			hidden.padEnd(7),
			updatedAt,
		].join(" ");
	}
	// Pipe-friendly: tab-separated.
	return [id, title, color, hidden, updatedAt].join("\t");
}

function renderPadList(notes: Note[]): string {
	if (notes.length === 0) {
		return isTTY() ? dim("(no pads)") : "";
	}
	const lines: string[] = [];
	if (isTTY()) {
		lines.push(
			bold(
				[
					"id".padEnd(36),
					"title".padEnd(40),
					"color".padEnd(8),
					"hidden".padEnd(7),
					"createdAt",
				].join(" "),
			),
		);
	}
	for (const note of notes) lines.push(formatPadRow(note));
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Meeting rendering
// ---------------------------------------------------------------------------

function formatMeetingRow(meeting: MeetingMeta): string {
	const id = meeting.id;
	const name = meeting.name ?? id.slice(0, 16);
	const startedAt = isoOrEmpty(meeting.startedAt);
	const endedAt = isoOrEmpty(meeting.endedAt);
	const mode = meeting.mode;
	const counts = `${meeting.nodeCount}n/${meeting.edgeCount}e/${meeting.thoughtCount}t`;
	if (isTTY()) {
		return [
			id.padEnd(40),
			name.padEnd(28),
			startedAt.padEnd(20),
			endedAt.padEnd(20),
			mode.padEnd(5),
			counts,
		].join(" ");
	}
	return [id, name, startedAt, endedAt, mode, counts].join("\t");
}

function renderMeetingList(meetings: MeetingMeta[]): string {
	if (meetings.length === 0) {
		return isTTY() ? dim("(no meetings)") : "";
	}
	const lines: string[] = [];
	if (isTTY()) {
		lines.push(
			bold(
				[
					"id".padEnd(40),
					"name".padEnd(28),
					"started".padEnd(20),
					"ended".padEnd(20),
					"mode".padEnd(5),
					"counts",
				].join(" "),
			),
		);
	}
	for (const m of meetings) lines.push(formatMeetingRow(m));
	return lines.join("\n");
}

function isoOrEmpty(epochMs: number): string {
	if (!Number.isFinite(epochMs) || epochMs <= 0) return "—";
	try {
		return new Date(epochMs).toISOString();
	} catch {
		return "—";
	}
}

// ---------------------------------------------------------------------------
// Stdin helpers
// ---------------------------------------------------------------------------

async function readAllStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Editor helpers
// ---------------------------------------------------------------------------

function resolveEditor(): string {
	if (process.env.VISUAL) return process.env.VISUAL;
	if (process.env.EDITOR) return process.env.EDITOR;
	// Try vim then nano. We can't really probe `which` synchronously
	// without a child_process — fall back to "vim" and let exec fail
	// loudly if it isn't installed.
	return "vim";
}

async function editInExternalEditor(
	initial: string,
	id: string,
): Promise<{
	updated: string;
	exitCode: number;
}> {
	const tmpName = `aizuchi-${id}-${Math.random().toString(36).slice(2, 10)}.md`;
	const tmpPath = path.join(os.tmpdir(), tmpName);
	await fs.writeFile(tmpPath, initial, "utf-8");
	try {
		const editor = resolveEditor();
		// Bun.spawn with stdio:"inherit" gives the editor full control of
		// the terminal — exactly what an interactive editor needs.
		const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });
		const exitCode = result.status ?? 1;
		const updated = await fs.readFile(tmpPath, "utf-8");
		return { updated, exitCode };
	} finally {
		// Best-effort cleanup. Doesn't matter much if it fails.
		try {
			await fs.unlink(tmpPath);
		} catch {
			// noop
		}
	}
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const cli = cac("aizuchi");

// Global flags. Every subcommand inherits these.
cli.option("--json", "Emit canonical JSON instead of human output");
cli.option("--debug", "Print full stack traces on error");

// ---- ls ----------------------------------------------------------------

cli
	.command("ls", "List visible pads")
	.option("--all", "Include hidden pads (alias for --include-hidden)")
	.option("--include-hidden", "Include hidden pads alongside visible ones")
	.option("--hidden", "Show only hidden pads (alias for --only-hidden)")
	.option("--only-hidden", "Show only hidden pads")
	.action(async (opts) => {
		const flags = readFlags(opts);
		try {
			const client = await AizuchiClient.create();
			const onlyHidden = opts.hidden || opts.onlyHidden;
			const includeHidden = opts.all || opts.includeHidden;
			const listOpts = onlyHidden
				? ({ only: "hidden" } as const)
				: includeHidden
					? ({ include: "hidden" } as const)
					: {};
			const pads = await client.listPads(listOpts);
			if (flags.json) emitJson(pads);
			else process.stdout.write(`${renderPadList(pads)}\n`);
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- new ---------------------------------------------------------------

cli
	.command("new [body]", "Create a pad. Body comes from arg or stdin.")
	.option("--title <title>", "Optional title")
	.option("--color <color>", "Color: yellow|pink|blue|green")
	.action(async (bodyArg: string | undefined, opts) => {
		const flags = readFlags(opts);
		try {
			let body = bodyArg ?? "";
			if (!bodyArg) {
				if (process.stdin.isTTY) {
					throw new IpcClientError(
						"missing_body",
						"provide a body argument or pipe content via stdin.",
					);
				}
				body = (await readAllStdin()).replace(/\n+$/, "");
			}
			const client = await AizuchiClient.create();
			const note = await client.createPad({
				body,
				title: opts.title,
				color: opts.color,
			});
			if (flags.json) emitJson(note);
			else process.stdout.write(`${note.id}\n`);
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- cat ---------------------------------------------------------------

cli
	.command("cat <id>", "Print pad body to stdout")
	.action(async (id: string, opts) => {
		const flags = readFlags(opts);
		try {
			const client = await AizuchiClient.create();
			const note = await client.getPad(id);
			if (flags.json) emitJson(note);
			else process.stdout.write(`${note.body}\n`);
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- edit --------------------------------------------------------------

cli
	.command("edit <id>", "Open $EDITOR to update the pad")
	.action(async (id: string, opts) => {
		const flags = readFlags(opts);
		try {
			const client = await AizuchiClient.create();
			const note = await client.getPad(id);
			const original = note.body;
			const { updated, exitCode } = await editInExternalEditor(original, id);
			if (exitCode !== 0) {
				process.stderr.write(
					`aizuchi: editor exited ${exitCode}; not saving.\n`,
				);
				process.exit(1);
			}
			if (updated === original) {
				process.stdout.write("No changes.\n");
				return;
			}
			const result = await client.updatePad(id, { body: updated });
			if (flags.json) emitJson(result);
			else process.stdout.write("Updated.\n");
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- rm ----------------------------------------------------------------

cli
	.command("rm <id>", "Delete a pad")
	.option("--force", "Skip soft-delete (currently a no-op; reserved)")
	.action(async (id: string, opts) => {
		const flags = readFlags(opts);
		try {
			const client = await AizuchiClient.create();
			await client.deletePad(id);
			if (flags.json) emitJson({ ok: true, id });
			else process.stdout.write(`Deleted ${id}.\n`);
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- focus -------------------------------------------------------------

cli
	.command("focus <id>", "Bring a pad's window forward")
	.action(async (id: string, opts) => {
		const flags = readFlags(opts);
		try {
			const client = await AizuchiClient.create();
			await client.focusPad(id);
			if (flags.json) emitJson({ ok: true, id });
			else process.stdout.write(`Focused ${id}.\n`);
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- pad (subcommand group) ------------------------------------------

cli
	.command(
		"pad <subcommand> [arg]",
		"Pad visibility commands (hide|show|show-hidden)",
	)
	.action(async (subcommand: string, arg: string | undefined, opts) => {
		const flags = readFlags(opts);
		// Up-front validation. Runs before discovery so unknown
		// subcommands and missing args surface useful messages even when
		// the app isn't running.
		const known = new Set(["hide", "show", "show-hidden"]);
		if (!known.has(subcommand)) {
			process.stderr.write(
				`aizuchi: unknown pad subcommand '${subcommand}'. Try: hide, show, show-hidden.\n`,
			);
			process.exit(2);
		}
		const requiresArg: Record<string, true> = { hide: true, show: true };
		if (requiresArg[subcommand] && !arg) {
			process.stderr.write(`aizuchi: pad ${subcommand} requires the pad id.\n`);
			process.exit(1);
		}
		try {
			const client = await AizuchiClient.create();
			switch (subcommand) {
				case "hide": {
					try {
						const note = await client.hidePad(arg as string);
						if (flags.json) emitJson(note);
						else process.stdout.write(`Hidden: ${arg}\n`);
					} catch (e) {
						if (e instanceof NotFoundError) {
							process.stderr.write(`aizuchi: pad not found: ${arg}\n`);
							process.exit(1);
						}
						throw e;
					}
					return;
				}
				case "show": {
					try {
						const note = await client.showPad(arg as string);
						if (flags.json) emitJson(note);
						else process.stdout.write(`Restored: ${arg}\n`);
					} catch (e) {
						if (e instanceof NotFoundError) {
							process.stderr.write(`aizuchi: pad not found: ${arg}\n`);
							process.exit(1);
						}
						throw e;
					}
					return;
				}
				case "show-hidden": {
					const result = await client.showAllHidden();
					if (flags.json) emitJson(result);
					else if (result.restored === 0)
						process.stdout.write("No hidden pads.\n");
					else
						process.stdout.write(
							`Restored ${result.restored} hidden pad(s).\n`,
						);
					return;
				}
				default:
					process.stderr.write(
						`aizuchi: unknown pad subcommand '${subcommand}'. Try: hide, show, show-hidden.\n`,
					);
					process.exit(2);
			}
		} catch (err) {
			fatal(err, flags);
		}
	});

// ---- meeting ----------------------------------------------------------

cli
	.command(
		"meeting <subcommand> [id] [arg]",
		"Manage meetings (start|stop|ls|open|resume|rm|rename|import)",
	)
	.option("--mode <mode>", "live or demo", { default: "live" })
	.option("--force", "Reserved for symmetry with `pad rm` (currently no-op)")
	.action(
		async (
			subcommand: string,
			id: string | undefined,
			arg: string | undefined,
			opts,
		) => {
			const flags = readFlags(opts);
			// Up-front validation. Runs before discovery so unknown
			// subcommands and bad args surface useful messages even when
			// the app isn't running.
			const known = new Set([
				"ls",
				"start",
				"stop",
				"open",
				"resume",
				"rm",
				"rename",
				"import",
			]);
			if (!known.has(subcommand)) {
				process.stderr.write(
					`aizuchi: unknown meeting subcommand '${subcommand}'. Try: start, stop, ls, open, resume, rm, rename, import.\n`,
				);
				process.exit(2);
			}
			const requiresId: Record<string, true> = {
				stop: true,
				open: true,
				resume: true,
				rm: true,
				rename: true,
			};
			if (requiresId[subcommand] && !id) {
				process.stderr.write(
					`aizuchi: meeting ${subcommand} requires the meeting id.\n`,
				);
				process.exit(1);
			}
			if (subcommand === "rename" && (arg === undefined || arg === "")) {
				process.stderr.write(
					"aizuchi: meeting rename requires a non-empty name.\n",
				);
				process.exit(1);
			}
			// `meeting import <path>` reuses the [id] positional as the
			// path so we don't need a separate command shape.
			if (subcommand === "import" && (id === undefined || id === "")) {
				process.stderr.write(
					"aizuchi: meeting import requires a path to a transcript file (.txt / .md / .json).\n",
				);
				process.exit(1);
			}
			try {
				const client = await AizuchiClient.create();
				switch (subcommand) {
					case "ls": {
						const meetings = await client.listMeetings();
						if (flags.json) emitJson(meetings);
						else process.stdout.write(`${renderMeetingList(meetings)}\n`);
						return;
					}
					case "start": {
						const mode = String(opts.mode);
						if (mode !== "demo" && mode !== "live") {
							throw new IpcClientError(
								"validation_error",
								`--mode must be 'demo' or 'live' (got ${JSON.stringify(mode)}).`,
							);
						}
						const result = await client.startMeeting(mode);
						if (flags.json) emitJson(result);
						else
							process.stdout.write(
								`Started ${mode} meeting ${result.id}. Window opened.\n`,
							);
						return;
					}
					case "stop": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting stop requires the meeting id. Use `aizuchi meeting ls` to find it.\n",
							);
							process.exit(1);
						}
						const meta = await client.stopMeeting(id);
						if (flags.json) emitJson(meta);
						else
							process.stdout.write(
								`Stopped ${id}. ended=${isoOrEmpty(meta.endedAt)}.\n`,
							);
						return;
					}
					case "open": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting open requires the meeting id.\n",
							);
							process.exit(1);
						}
						await client.openMeeting(id);
						if (flags.json) emitJson({ ok: true, id });
						else process.stdout.write(`Opened ${id}.\n`);
						return;
					}
					case "resume": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting resume requires the meeting id.\n",
							);
							process.exit(1);
						}
						try {
							const result = await client.resumeMeeting(id);
							if (flags.json) emitJson(result);
							else process.stdout.write(`Resumed: ${id}. Window opened.\n`);
						} catch (e) {
							if (e instanceof NotFoundError) {
								process.stderr.write(`aizuchi: meeting not found: ${id}\n`);
								process.exit(1);
							}
							throw e;
						}
						return;
					}
					case "rm": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting rm requires the meeting id.\n",
							);
							process.exit(1);
						}
						try {
							await client.deleteMeeting(id);
							if (flags.json) emitJson({ ok: true, id });
							else process.stdout.write(`Deleted: ${id}\n`);
						} catch (e) {
							if (e instanceof NotFoundError) {
								process.stderr.write(`aizuchi: meeting not found: ${id}\n`);
								process.exit(1);
							}
							throw e;
						}
						return;
					}
					case "import": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting import requires a path to a transcript file (.txt / .md / .json).\n",
							);
							process.exit(1);
						}
						const filePath = path.resolve(id);
						let content: string;
						try {
							content = await fs.readFile(filePath, "utf-8");
						} catch (e) {
							process.stderr.write(
								`aizuchi: failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`,
							);
							process.exit(1);
						}
						const filename = path.basename(filePath);
						const result = await client.importMeeting({ content, filename });
						if (flags.json) emitJson(result);
						else
							process.stdout.write(
								`Imported ${result.chunkCount} chunk(s) from ${result.sourceFile} as ${result.id}. Window opened.\n`,
							);
						return;
					}
					case "rename": {
						if (!id) {
							process.stderr.write(
								"aizuchi: meeting rename requires the meeting id.\n",
							);
							process.exit(1);
						}
						if (arg === undefined || arg === "") {
							process.stderr.write(
								"aizuchi: meeting rename requires a non-empty name.\n",
							);
							process.exit(1);
						}
						try {
							const meta = await client.renameMeeting(id, arg, true);
							if (flags.json) emitJson(meta);
							else process.stdout.write(`Renamed: ${id} → "${arg}". Locked.\n`);
						} catch (e) {
							if (e instanceof NotFoundError) {
								process.stderr.write(`aizuchi: meeting not found: ${id}\n`);
								process.exit(1);
							}
							throw e;
						}
						return;
					}
					default:
						process.stderr.write(
							`aizuchi: unknown meeting subcommand '${subcommand}'. Try: start, stop, ls, open, resume, rm, rename.\n`,
						);
						process.exit(2);
				}
			} catch (err) {
				fatal(err, flags);
			}
		},
	);

// ---- status -----------------------------------------------------------

cli.command("status", "Show app status / IPC version").action(async (opts) => {
	const flags = readFlags(opts);
	try {
		const client = await AizuchiClient.create();
		const status = await client.status();
		if (flags.json) emitJson(status);
		else
			process.stdout.write(
				`Running. ${status.app.name} ${status.app.version}. IPC v${status.ipc.version}.\n`,
			);
	} catch (err) {
		fatal(err, flags);
	}
});

// ---- top-level / parse ------------------------------------------------

cli.help();
cli.version("0.1.0");

try {
	cli.parse(process.argv, { run: false });
	if (cli.matchedCommand === undefined && process.argv.length <= 2) {
		// No subcommand → show help instead of silently doing nothing.
		cli.outputHelp();
		process.exit(0);
	}
	await cli.runMatchedCommand();
} catch (err) {
	// cac throws CACError on unknown options, which we want to surface
	// like any other failure: friendly message + exit 1.
	fatal(err, { debug: process.argv.includes("--debug") });
}
