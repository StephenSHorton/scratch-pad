import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIpcConfig } from "./discovery";
import { AppNotRunningError, TokenPermsError } from "./errors";

const VALID_TOKEN =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let tmpDir = "";

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-core-discovery-"));
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

async function writeToken(perm = 0o600): Promise<string> {
	const tokenPath = path.join(tmpDir, "cli-token");
	await fs.writeFile(tokenPath, `${VALID_TOKEN}\n`, "utf-8");
	if (process.platform !== "win32") {
		await fs.chmod(tokenPath, perm);
	}
	return tokenPath;
}

async function writePort(port: number | string): Promise<void> {
	await fs.writeFile(path.join(tmpDir, "cli.port"), `${port}\n`, "utf-8");
}

describe("loadIpcConfig", () => {
	it("returns baseUrl + token on the happy path", async () => {
		await writeToken();
		await writePort(48123);

		const cfg = await loadIpcConfig(tmpDir);
		expect(cfg.token).toBe(VALID_TOKEN);
		expect(cfg.baseUrl).toBe("http://127.0.0.1:48123");
	});

	it("throws AppNotRunningError if the token file is missing", async () => {
		await writePort(48123);
		await expect(loadIpcConfig(tmpDir)).rejects.toBeInstanceOf(
			AppNotRunningError,
		);
	});

	it("throws AppNotRunningError if the port file is missing", async () => {
		await writeToken();
		await expect(loadIpcConfig(tmpDir)).rejects.toBeInstanceOf(
			AppNotRunningError,
		);
	});

	if (process.platform !== "win32") {
		it("throws TokenPermsError if the token is group/world-readable", async () => {
			await writeToken(0o644);
			await writePort(48123);

			let caught: unknown;
			try {
				await loadIpcConfig(tmpDir);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(TokenPermsError);
			expect((caught as Error).message).toContain("chmod 600");
		});
	}

	it("rejects malformed port files", async () => {
		await writeToken();
		await writePort("not-a-port");
		await expect(loadIpcConfig(tmpDir)).rejects.toThrow(/malformed/);
	});

	it("trims trailing whitespace on the token", async () => {
		const tokenPath = path.join(tmpDir, "cli-token");
		await fs.writeFile(tokenPath, `${VALID_TOKEN}  \n\n`, "utf-8");
		if (process.platform !== "win32") await fs.chmod(tokenPath, 0o600);
		await writePort(48123);
		const cfg = await loadIpcConfig(tmpDir);
		expect(cfg.token).toBe(VALID_TOKEN);
	});
});
