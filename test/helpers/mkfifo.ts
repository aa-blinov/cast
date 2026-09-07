import { execFileSync } from "node:child_process";

/** Creates a FIFO at `path`. Node has no mkfifo binding, so shell out. */
export function mkfifoSync(path: string): void {
	execFileSync("mkfifo", [path]);
}
