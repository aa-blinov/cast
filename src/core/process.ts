import { spawn } from "node:child_process";
import { win32 } from "node:path";

export type ProcessTreeKillAction =
	| { type: "signal"; pid: number; signal: "SIGTERM" | "SIGKILL" }
	| { type: "command"; command: "powershell.exe"; args: string[] };

const WINDOWS_USR_BIN_RE = /[\\/]usr[\\/]bin$/i;

export function windowsTimeoutPath(bashPath: string): string {
	const bashDirectory = win32.dirname(bashPath);
	const timeoutDirectory = WINDOWS_USR_BIN_RE.test(bashDirectory)
		? bashDirectory
		: win32.join(bashDirectory, "..", "usr", "bin");
	return win32.join(timeoutDirectory, "timeout.exe");
}

function windowsKillTreeScript(pid: number, signal: "SIGTERM" | "SIGKILL"): string {
	const force = signal === "SIGKILL" ? " -Force" : "";
	return `$root=${pid}; $all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($root); do { $count=$ids.Count; foreach ($proc in $all) { if ($ids.Contains([int]$proc.ParentProcessId)) { [void]$ids.Add([int]$proc.ProcessId) } } } while ($ids.Count -gt $count); foreach ($id in ($ids | Where-Object { $_ -ne $root })) { Stop-Process -Id $id${force} -ErrorAction SilentlyContinue }; Stop-Process -Id $root${force} -ErrorAction SilentlyContinue; exit 0`;
}

export function processTreeKillAction(
	pid: number,
	signal: "SIGTERM" | "SIGKILL",
	platform: NodeJS.Platform = process.platform,
): ProcessTreeKillAction {
	if (platform === "win32") {
		return {
			type: "command",
			command: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", windowsKillTreeScript(pid, signal)],
		};
	}
	return { type: "signal", pid: -pid, signal };
}

/** Stops a child and its descendants using the platform's process-tree primitive. */
export function killProcessTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void {
	if (pid === undefined) return;
	const action = processTreeKillAction(pid, signal);
	if (action.type === "signal") {
		try {
			process.kill(action.pid, action.signal);
		} catch {
			try {
				process.kill(pid, action.signal);
			} catch {
				// The process group may already have exited.
			}
		}
		return;
	}

	const killer = spawn(action.command, action.args, { stdio: "ignore", windowsHide: true });
	const fallback = () => {
		const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
			stdio: "ignore",
			windowsHide: true,
		});
		const killRoot = () => {
			try {
				process.kill(pid, signal);
			} catch {
				// The process may already have exited or taskkill may have reaped it.
			}
		};
		taskkill.on("error", killRoot);
		taskkill.on("close", (code) => {
			if (code !== 0) killRoot();
		});
	};
	killer.on("error", fallback);
	killer.on("close", (code) => {
		if (code !== 0) fallback();
	});
	killer.unref();
}
