#!/usr/bin/env node
/**
 * Make node-pty's macOS spawn-helper executable.
 *
 * node-pty's own install script does this, but cast's install line is
 * `npm install --ignore-scripts` (to skip the git-hook `prepare` step), which
 * skips it too. The npm tarball ships `spawn-helper` at mode 644: the native
 * module still loads, and `pty.spawn` then fails with "posix_spawnp failed" —
 * every `bash` call in the session dies with that message, because cast runs
 * interactive commands through the PTY.
 *
 * Idempotent and safe to run anywhere: it only adds the execute bit to a
 * helper that exists and is not executable yet.
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Every node-pty copy the checkout can see, resolved the way Node resolves it. */
function candidateDirs() {
	const dirs = [];
	try {
		const entry = require.resolve("node-pty/package.json");
		dirs.push(join(dirname(entry), "prebuilds"));
	} catch {
		// node-pty not installed — nothing to fix.
	}
	return dirs;
}

function helperFiles(root) {
	if (!existsSync(root)) return [];
	const found = [];
	for (const platform of readdirSync(root)) {
		const dir = join(root, platform);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const helper = join(dir, "spawn-helper");
		if (existsSync(helper)) found.push(helper);
	}
	return found;
}

let fixed = 0;
for (const root of candidateDirs()) {
	for (const helper of helperFiles(root)) {
		try {
			const mode = statSync(helper).mode;
			// Owner execute bit is 0o100 — the bit the kernel checks for the
			// owner, which is the user running the harness.
			if ((mode & 0o100) !== 0) continue;
			chmodSync(helper, mode | 0o100);
			console.log(`[pty] made ${helper} executable`);
			fixed++;
		} catch (error) {
			console.error(`[pty] could not fix ${helper}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

if (fixed === 0) {
	console.log("[pty] node-pty's spawn-helper is already executable (or absent)");
}
