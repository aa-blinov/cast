import { symlinkSync } from "node:fs";
import type { TestContext } from "vitest";

export function createTestSymlink(context: TestContext, target: string, linkPath: string, type: "dir" | "file"): void {
	try {
		symlinkSync(target, linkPath, process.platform === "win32" && type === "dir" ? "junction" : type);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
			context.skip("This Windows account cannot create symbolic links.");
		}
		throw error;
	}
}
