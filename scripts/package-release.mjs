#!/usr/bin/env node
/**
 * Stage the files that belong in one platform-specific release archive.
 *
 * node-pty's npm package contains sources, tests, maps, and Windows debug
 * symbols. None of those are needed after install; the native loader only
 * needs lib/ plus the matching build/prebuild directory.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
]);

function usage() {
	console.error("Usage: node scripts/package-release.mjs --target <platform-arch> --stage <directory>");
	process.exit(2);
}

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) usage();
	return process.argv[index + 1];
}

function copyTree(source, destination, filter) {
	cpSync(source, destination, {
		recursive: true,
		filter: (entry) => filter(entry, relative(source, entry)),
	});
}

function copyRuntimeLibrary(source, destination) {
	copyTree(source, destination, (entry) => {
		const name = entry.slice(source.length + 1);
		return !name.endsWith(".map") && !name.endsWith(".test.js");
	});
}

function copyNativeDirectory(source, destination) {
	copyTree(source, destination, (entry) => !entry.endsWith(".pdb"));
}

function resolveLockedDependency(name, fromKey, packages) {
	let directory = fromKey;
	for (;;) {
		const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
		if (packages[candidate]) return candidate;
		if (!directory) return undefined;
		const parent = directory.slice(0, directory.lastIndexOf("/"));
		directory = parent === directory ? "" : parent;
	}
}

function copyDependencyTree(name, fromKey, root, stage, packages, copied = new Set()) {
	const packageKey = resolveLockedDependency(name, fromKey, packages);
	if (!packageKey) throw new Error(`Missing locked runtime dependency ${name} from ${fromKey || "the project"}`);
	if (copied.has(packageKey)) return;
	copied.add(packageKey);
	copyTree(join(root, packageKey), join(stage, packageKey), () => true);
	const metadata = packages[packageKey];
	const optional = metadata.optionalDependencies ?? {};
	for (const dependency of Object.keys({ ...metadata.dependencies, ...optional })) {
		if (!resolveLockedDependency(dependency, packageKey, packages) && dependency in optional) continue;
		copyDependencyTree(dependency, packageKey, root, stage, packages, copied);
	}
}

function requireFile(path, description) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error("Missing " + description + ": " + path);
	}
}

function nativeSourceFor(target, nodePty) {
	if (target.startsWith("linux-")) {
		const prebuild = join(nodePty, "prebuilds", target);
		if (existsSync(join(prebuild, "pty.node"))) return prebuild;
		const targetArch = target.slice("linux-".length);
		if (process.platform !== "linux" || process.arch !== targetArch) {
			throw new Error(
				"Building " +
					target +
					" requires a matching Linux runner; current runtime is " +
					process.platform +
					"-" +
					process.arch,
			);
		}
		return join(nodePty, "build", "Release");
	}
	return join(nodePty, "prebuilds", target);
}

function validateNativeFiles(target, nativeSource) {
	if (target.startsWith("darwin-")) {
		requireFile(join(nativeSource, "pty.node"), target + " pty.node");
		requireFile(join(nativeSource, "spawn-helper"), target + " spawn-helper");
		return;
	}
	if (target.startsWith("win32-")) {
		for (const file of [
			"pty.node",
			"conpty.node",
			"conpty_console_list.node",
			"winpty-agent.exe",
			"winpty.dll",
			"conpty/conpty.dll",
			"conpty/OpenConsole.exe",
		]) {
			requireFile(join(nativeSource, file), target + " " + file);
		}
		return;
	}
	requireFile(join(nativeSource, "pty.node"), target + " pty.node");
}

function main() {
	const target = argument("--target");
	const stage = resolve(argument("--stage"));
	if (!TARGETS.has(target)) {
		throw new Error("Unsupported target " + target + "; expected one of " + [...TARGETS].join(", "));
	}

	const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	const nodePty = join(root, "node_modules", "node-pty");
	const nativeSource = nativeSourceFor(target, nodePty);
	validateNativeFiles(target, nativeSource);

	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true });
	for (const directory of ["dist", "prompts", "bin"]) {
		copyTree(join(root, directory), join(stage, directory), () => true);
	}
	for (const file of ["package.json", "README.md"]) {
		cpSync(join(root, file), join(stage, file));
	}
	mkdirSync(join(stage, "node_modules", "node-pty"), { recursive: true });
	cpSync(join(nodePty, "package.json"), join(stage, "node_modules", "node-pty", "package.json"));
	copyRuntimeLibrary(join(nodePty, "lib"), join(stage, "node_modules", "node-pty", "lib"));
	const stagedNative = target.startsWith("linux-")
		? join(stage, "node_modules", "node-pty", "build", "Release")
		: join(stage, "node_modules", "node-pty", "prebuilds", target);
	copyNativeDirectory(nativeSource, stagedNative);
	copyDependencyTree("@anthropic-ai/sandbox-runtime", "", root, stage, lockfile.packages);

	console.log(JSON.stringify({ target, stage, nativeSource }, null, 2));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
