import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { killProcessTree, processTreeKillAction, windowsTimeoutPath } from "../src/core/process.ts";

describe("processTreeKillAction", () => {
	it("finds Git Bash's timeout utility next to a discovered Bash executable", () => {
		expect(windowsTimeoutPath("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(
			"C:\\Program Files\\Git\\usr\\bin\\timeout.exe",
		);
		expect(windowsTimeoutPath("D:\\portable\\Git\\usr\\bin\\bash.exe")).toBe(
			"D:\\portable\\Git\\usr\\bin\\timeout.exe",
		);
	});

	it("uses taskkill with the process tree on Windows", () => {
		const action = processTreeKillAction(42, "SIGKILL", "win32");
		expect(action).toMatchObject({
			type: "command",
			command: "powershell.exe",
		});
		if (action.type === "command") {
			expect(action.args).toEqual([
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				expect.stringContaining("Get-CimInstance Win32_Process"),
			]);
			expect(action.args[3]).toContain("ParentProcessId");
			expect(action.args[3]).toContain("Stop-Process");
			expect(action.args[3]).toContain("$root=42");
		}
	});

	it("does not force a graceful Windows process-tree termination", () => {
		const action = processTreeKillAction(42, "SIGTERM", "win32");
		expect(action).toMatchObject({
			type: "command",
			command: "powershell.exe",
		});
		if (action.type === "command") expect(action.args[3]).not.toContain("Stop-Process -Id $id -Force");
	});

	it("signals the whole detached process group on POSIX", () => {
		expect(processTreeKillAction(42, "SIGKILL", "darwin")).toEqual({
			type: "signal",
			pid: -42,
			signal: "SIGKILL",
		});
	});

	it.skipIf(process.platform !== "win32")("closes native Windows descendants with their parent", async () => {
		const child = spawn("cmd.exe", ["/d", "/s", "/c", "ping -n 30 127.0.0.1 > nul"], {
			stdio: "ignore",
			windowsHide: true,
		});
		const closed = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), 3_000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		killProcessTree(child.pid, "SIGKILL");
		const didClose = await closed;
		if (!didClose) killProcessTree(child.pid, "SIGKILL");
		expect(didClose).toBe(true);
	});
});
