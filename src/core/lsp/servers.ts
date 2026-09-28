/**
 * The language servers cast knows how to find and start, by file extension.
 * A server is used only when its command resolves: the project's own
 * node_modules/.bin, then PATH, then cast's cache (~/.cast/lsp), where the
 * npm-distributed ones are installed on first use unless `lspAutoInstall` is
 * off. Everything else (gopls, rust-analyzer, clangd, ...) is used when the
 * user has it installed.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export interface ServerSpawn {
	command: string;
	args: string[];
	env?: Record<string, string>;
	initializationOptions?: unknown;
	/** What `workspace/configuration` answers. */
	settings?: Record<string, unknown>;
}

export interface ServerDef {
	id: string;
	/** Extensions with the dot, or whole basenames (`Dockerfile`). */
	extensions: string[];
	/** Files whose nearest directory is the server's root. */
	rootMarkers: string[];
	/** No marker found means the server does not apply (a Deno project, a Cargo crate). */
	strictRoot?: boolean;
	/** A root with one of these belongs to another server (Deno vs Node). */
	excludeMarkers?: string[];
	/** Whether the project uses this server at all (eslint: only with the project's eslint). */
	applies?: (root: string) => boolean;
	/** The command for this root, or undefined when it can't run here. */
	resolve: (root: string, ctx: ResolveContext) => Promise<ServerSpawn | undefined>;
}

export interface ResolveContext {
	/** May cast install npm packages into its cache? */
	autoInstall: boolean;
}

/** Where cast installs the npm-distributed servers. */
export function lspCacheDir(): string {
	return join(homedir(), ".cast", "lsp");
}

function onPath(bin: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** A binary from the project (walking up from `root`), PATH, or extra dirs. */
function findBin(bin: string, root: string, extraDirs: string[] = []): string | undefined {
	let dir = root;
	while (true) {
		const local = join(dir, "node_modules", ".bin", bin);
		if (existsSync(local)) return local;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return onPath(bin) ?? extraDirs.map((d) => join(d, bin)).find((p) => existsSync(p));
}

function cacheBin(bin: string): string | undefined {
	const p = join(lspCacheDir(), "node_modules", ".bin", bin);
	return existsSync(p) ? p : undefined;
}

const installs = new Map<string, Promise<boolean>>();
/** npm installs into the one cache directory run one after another: two at once corrupt it. */
let installQueue: Promise<unknown> = Promise.resolve();

/**
 * Installs npm packages into cast's LSP cache. `--ignore-scripts`: a language
 * server needs no install hooks, and none runs on the user's machine unasked.
 * One install per package set at a time; a failure is not retried this process.
 */
export function npmInstall(packages: string[]): Promise<boolean> {
	const key = packages.join(" ");
	const running = installs.get(key);
	if (running) return running;
	const dir = lspCacheDir();
	const run = () =>
		new Promise<boolean>((done) => {
			try {
				mkdirSync(dir, { recursive: true });
				if (!existsSync(join(dir, "package.json"))) {
					writeFileSync(join(dir, "package.json"), '{"name":"cast-lsp-cache","private":true}\n');
				}
			} catch {
				done(false);
				return;
			}
			execFile(
				process.platform === "win32" ? "npm.cmd" : "npm",
				["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", ...packages],
				{ cwd: dir, timeout: 180_000 },
				(error) => done(!error),
			);
		});
	const job = installQueue.then(run, run);
	installQueue = job;
	installs.set(key, job);
	return job;
}

/** A bin from the project, PATH or cache; installed into the cache when allowed. */
async function npmServer(
	bin: string,
	packages: string[],
	root: string,
	ctx: ResolveContext,
): Promise<string | undefined> {
	const found = findBin(bin, root) ?? cacheBin(bin);
	if (found) return found;
	if (!ctx.autoInstall || !onPath("npm")) return undefined;
	return (await npmInstall(packages)) ? cacheBin(bin) : undefined;
}

/** A server released as a GitHub asset, one archive per platform. */
interface ReleaseSpec {
	repo: string;
	/** The asset for this OS and CPU, or undefined when there is none. */
	asset: (os: "linux" | "darwin" | "win32", arch: "x64" | "arm64") => RegExp | undefined;
	/** The executable's file name inside the archive. */
	bin: string;
}

const downloads = new Map<string, Promise<string | undefined>>();

function findFile(dir: string, name: string): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const found = findFile(full, name);
			if (found) return found;
		}
	}
	return undefined;
}

function run(cmd: string, args: string[], cwd: string): Promise<boolean> {
	return new Promise((done) => execFile(cmd, args, { cwd, timeout: 300_000 }, (e) => done(!e)));
}

/**
 * Downloads a server's latest release into ~/.cast/lsp/bin/<id>, once. Only
 * with `lspAutoInstall` on; a download that fails isn't retried this process.
 */
function githubRelease(id: string, spec: ReleaseSpec): Promise<string | undefined> {
	const running = downloads.get(id);
	if (running) return running;
	const job = (async () => {
		const dir = join(lspCacheDir(), "bin", id);
		const bin = process.platform === "win32" ? `${spec.bin}.exe` : spec.bin;
		if (existsSync(dir)) {
			const found = findFile(dir, bin);
			if (found) return found;
		}
		const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		const pattern = spec.asset(os, arch);
		if (!pattern) return undefined;
		try {
			const release = (await (
				await fetch(`https://api.github.com/repos/${spec.repo}/releases/latest`, {
					headers: { accept: "application/vnd.github+json", "user-agent": "cast" },
					signal: AbortSignal.timeout(30_000),
				})
			).json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
			const asset = release.assets?.find((a) => pattern.test(a.name));
			if (!asset) return undefined;
			const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
			if (!response.ok) return undefined;
			mkdirSync(dir, { recursive: true });
			const archive = join(dir, asset.name);
			writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
			if (asset.name.endsWith(".zip")) {
				const ok = onPath("unzip")
					? await run("unzip", ["-q", "-o", archive], dir)
					: await run("tar", ["-xf", archive], dir);
				if (!ok) return undefined;
			} else if (asset.name.includes(".tar.")) {
				if (!(await run("tar", ["-xf", archive], dir))) return undefined;
			} else if (asset.name.endsWith(".gz")) {
				writeFileSync(join(dir, bin), gunzipSync(readFileSync(archive)));
			}
			rmSync(archive, { force: true });
			const found = findFile(dir, bin);
			if (found) chmodSync(found, 0o755);
			return found;
		} catch {
			return undefined;
		}
	})();
	downloads.set(id, job);
	return job;
}

/** On PATH (or in `extraDirs`), else downloaded when allowed. */
function releaseServer(id: string, spec: ReleaseSpec, args: string[], extraDirs: string[] = []): ServerDef["resolve"] {
	return async (root, ctx) => {
		const found = findBin(spec.bin, root, extraDirs);
		if (found) return { command: found, args };
		const cached = existsSync(join(lspCacheDir(), "bin", id))
			? findFile(join(lspCacheDir(), "bin", id), process.platform === "win32" ? `${spec.bin}.exe` : spec.bin)
			: undefined;
		const command = cached ?? (ctx.autoInstall ? await githubRelease(id, spec) : undefined);
		return command ? { command, args } : undefined;
	};
}

const OS_WORD = { linux: "linux", darwin: "macos", win32: "windows" } as const;
const CPU_WORD = { x64: "x86_64", arm64: "aarch64" } as const;
const TRIPLE = { linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" } as const;

function pathServer(bin: string, args: string[], extraDirs: string[] = []): ServerDef["resolve"] {
	return async (root) => {
		const command = findBin(bin, root, extraDirs);
		return command ? { command, args } : undefined;
	};
}

function packageVersion(root: string, pkg: string): number | undefined {
	let dir = root;
	while (true) {
		try {
			const json = JSON.parse(readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf-8")) as {
				version?: string;
			};
			return Number.parseInt(json.version ?? "", 10);
		} catch {
			// Not here: keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function findUp(root: string, rel: string): string | undefined {
	let dir = root;
	while (true) {
		const p = join(dir, rel);
		if (existsSync(p)) return p;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * TypeScript/JavaScript. TypeScript 7 is native and serves LSP itself
 * (`tsc --lsp --stdio`); 5.x goes through typescript-language-server with the
 * project's own tsserver, so diagnostics match the project's compiler. A
 * project with neither gets a cached TypeScript 7.
 */
async function resolveTypescript(root: string, ctx: ResolveContext): Promise<ServerSpawn | undefined> {
	const version = packageVersion(root, "typescript");
	if (version !== undefined && version >= 7) {
		const tsc = findBin("tsc", root);
		if (tsc) return { command: tsc, args: ["--lsp", "--stdio"] };
	}
	const tsserver = findUp(root, join("node_modules", "typescript", "lib", "tsserver.js"));
	if (tsserver) {
		const command = await npmServer("typescript-language-server", ["typescript-language-server"], root, ctx);
		if (command) return { command, args: ["--stdio"], initializationOptions: { tsserver: { path: tsserver } } };
	}
	// Another cached server may have brought a TypeScript 5 along: only 7 serves LSP itself.
	const cached = () => ((packageVersion(lspCacheDir(), "typescript") ?? 0) >= 7 ? cacheBin("tsc") : undefined);
	let tsc = cached();
	if (!tsc && ctx.autoInstall && onPath("npm") && (await npmInstall(["typescript@^7"]))) tsc = cached();
	return tsc ? { command: tsc, args: ["--lsp", "--stdio"] } : undefined;
}

/** The project's Python, so imports resolve against its virtualenv. */
function pythonPathFor(root: string): string | undefined {
	const bin = process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
	const venv = process.env.VIRTUAL_ENV;
	if (venv && existsSync(join(venv, bin))) return join(venv, bin);
	for (const name of [".venv", "venv"]) {
		const p = findUp(root, join(name, bin));
		if (p) return p;
	}
	return undefined;
}

async function resolvePython(root: string, ctx: ResolveContext): Promise<ServerSpawn | undefined> {
	const pythonPath = pythonPathFor(root);
	const settings = pythonPath ? { python: { pythonPath } } : undefined;
	const based = findBin("basedpyright-langserver", root);
	if (based) return { command: based, args: ["--stdio"], settings };
	const command = await npmServer("pyright-langserver", ["pyright"], root, ctx);
	return command ? { command, args: ["--stdio"], settings, initializationOptions: settings } : undefined;
}

async function resolveGopls(root: string, ctx: ResolveContext): Promise<ServerSpawn | undefined> {
	const goBin = join(process.env.GOPATH ?? join(homedir(), "go"), "bin");
	const found = findBin("gopls", root, [goBin, join(lspCacheDir(), "go", "bin")]);
	if (found) return { command: found, args: [] };
	if (!ctx.autoInstall || !onPath("go")) return undefined;
	const gobin = join(lspCacheDir(), "go", "bin");
	const ok = await new Promise<boolean>((done) =>
		execFile(
			"go",
			["install", "golang.org/x/tools/gopls@latest"],
			{ env: { ...process.env, GOBIN: gobin }, timeout: 300_000 },
			(e) => done(!e),
		),
	);
	return ok && existsSync(join(gobin, "gopls")) ? { command: join(gobin, "gopls"), args: [] } : undefined;
}

const JS_TS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const NODE_ROOT = ["tsconfig.json", "jsconfig.json", "package.json"];
const NODE_LOCKS = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"];

export const BUILTIN_SERVERS: ServerDef[] = [
	{
		id: "deno",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
		rootMarkers: ["deno.json", "deno.jsonc"],
		strictRoot: true,
		resolve: pathServer("deno", ["lsp"]),
	},
	{
		id: "typescript",
		extensions: JS_TS,
		rootMarkers: [...NODE_ROOT, ...NODE_LOCKS],
		excludeMarkers: ["deno.json", "deno.jsonc"],
		resolve: resolveTypescript,
	},
	{
		id: "vue",
		extensions: [".vue"],
		rootMarkers: [...NODE_ROOT, ...NODE_LOCKS],
		resolve: async (root, ctx) => {
			const command = await npmServer("vue-language-server", ["@vue/language-server"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "svelte",
		extensions: [".svelte"],
		rootMarkers: [...NODE_ROOT, ...NODE_LOCKS],
		resolve: async (root, ctx) => {
			const command = await npmServer("svelteserver", ["svelte-language-server"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "astro",
		extensions: [".astro"],
		rootMarkers: [...NODE_ROOT, ...NODE_LOCKS],
		resolve: async (root, ctx) => {
			const command = await npmServer("astro-ls", ["@astrojs/language-server"], root, ctx);
			const tsdk = findUp(root, join("node_modules", "typescript", "lib"));
			return command
				? { command, args: ["--stdio"], initializationOptions: tsdk ? { typescript: { tsdk } } : undefined }
				: undefined;
		},
	},
	{
		id: "biome",
		extensions: [...JS_TS, ".json", ".jsonc", ".css", ".graphql", ".gql", ".vue", ".astro", ".svelte"],
		rootMarkers: ["biome.json", "biome.jsonc"],
		strictRoot: true,
		// The project's own biome only: its rules are the project's config.
		resolve: async (root) => {
			let dir = root;
			while (true) {
				const local = join(dir, "node_modules", ".bin", "biome");
				if (existsSync(local)) return { command: local, args: ["lsp-proxy"] };
				const parent = dirname(dir);
				if (parent === dir) return undefined;
				dir = parent;
			}
		},
	},
	{
		id: "eslint",
		extensions: [...JS_TS, ".vue", ".svelte", ".astro"],
		rootMarkers: [...NODE_ROOT, ...NODE_LOCKS],
		// Only where the project uses eslint: its config and plugins are the point.
		applies: (root) => findUp(root, join("node_modules", "eslint", "package.json")) !== undefined,
		resolve: async (root, ctx) => {
			const command = await npmServer("vscode-eslint-language-server", ["vscode-langservers-extracted"], root, ctx);
			if (!command) return undefined;
			// What the VS Code extension sends; without it the server lints nothing.
			const settings = {
				validate: "on",
				run: "onType",
				packageManager: "npm",
				useESLintClass: false,
				experimental: {},
				codeAction: {
					disableRuleComment: { enable: true, location: "separateLine" },
					showDocumentation: { enable: true },
				},
				codeActionOnSave: { enable: false, mode: "all" },
				format: false,
				quiet: false,
				onIgnoredFiles: "off",
				options: {},
				rulesCustomizations: [],
				problems: { shortenToSingleLine: false },
				nodePath: null,
				workingDirectory: { mode: "location" },
				workspaceFolder: { uri: pathToFileURL(root).href, name: basename(root) },
			};
			return { command, args: ["--stdio"], settings };
		},
	},
	{
		id: "oxlint",
		extensions: [...JS_TS, ".vue", ".svelte", ".astro"],
		rootMarkers: [".oxlintrc.json", "oxlintrc.json"],
		strictRoot: true,
		resolve: async (root) => {
			const oxlint = findBin("oxlint", root);
			if (oxlint) return { command: oxlint, args: ["--lsp"] };
			const server = findBin("oxc_language_server", root);
			return server ? { command: server, args: [] } : undefined;
		},
	},
	{
		id: "pyright",
		extensions: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"],
		resolve: resolvePython,
	},
	{
		id: "gopls",
		extensions: [".go"],
		rootMarkers: ["go.work", "go.mod", "go.sum"],
		resolve: resolveGopls,
	},
	{
		id: "rust-analyzer",
		extensions: [".rs"],
		rootMarkers: ["Cargo.toml", "Cargo.lock"],
		strictRoot: true,
		resolve: releaseServer(
			"rust-analyzer",
			{
				repo: "rust-lang/rust-analyzer",
				asset: (os, arch) =>
					os === "win32"
						? new RegExp(`^rust-analyzer-${CPU_WORD[arch]}-${TRIPLE[os]}\\.zip$`)
						: new RegExp(`^rust-analyzer-${CPU_WORD[arch]}-${TRIPLE[os]}\\.gz$`),
				bin: "rust-analyzer",
			},
			[],
			[join(homedir(), ".cargo", "bin")],
		),
	},
	{
		id: "clangd",
		extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".m", ".mm"],
		rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"],
		resolve: releaseServer(
			"clangd",
			{
				repo: "clangd/clangd",
				// Linux builds are x86_64 only; mac builds are universal.
				asset: (os, arch) =>
					os === "linux" && arch === "arm64"
						? undefined
						: new RegExp(`^clangd-${{ linux: "linux", darwin: "mac", win32: "windows" }[os]}-[\\d.]+\\.zip$`),
				bin: "clangd",
			},
			["--background-index", "--clang-tidy"],
		),
	},
	{
		id: "ruby",
		extensions: [".rb", ".rake", ".gemspec", ".ru"],
		rootMarkers: ["Gemfile"],
		resolve: async (root) => {
			const lsp = findBin("ruby-lsp", root);
			if (lsp) return { command: lsp, args: [] };
			const rubocop = findBin("rubocop", root);
			return rubocop ? { command: rubocop, args: ["--lsp"] } : undefined;
		},
	},
	{
		id: "bash",
		extensions: [".sh", ".bash", ".zsh", ".ksh"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("bash-language-server", ["bash-language-server"], root, ctx);
			return command ? { command, args: ["start"] } : undefined;
		},
	},
	{
		id: "yaml",
		extensions: [".yaml", ".yml"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("yaml-language-server", ["yaml-language-server"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "json",
		extensions: [".json", ".jsonc"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("vscode-json-language-server", ["vscode-langservers-extracted"], root, ctx);
			return command
				? { command, args: ["--stdio"], initializationOptions: { provideFormatter: false } }
				: undefined;
		},
	},
	{
		id: "css",
		extensions: [".css", ".scss", ".less"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("vscode-css-language-server", ["vscode-langservers-extracted"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "html",
		extensions: [".html", ".htm"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("vscode-html-language-server", ["vscode-langservers-extracted"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "php",
		extensions: [".php"],
		rootMarkers: ["composer.json", "composer.lock", ".php-version"],
		resolve: async (root, ctx) => {
			const command = await npmServer("intelephense", ["intelephense"], root, ctx);
			return command
				? { command, args: ["--stdio"], initializationOptions: { telemetry: { enabled: false } } }
				: undefined;
		},
	},
	{
		id: "dockerfile",
		extensions: [".dockerfile", "Dockerfile"],
		rootMarkers: [],
		resolve: async (root, ctx) => {
			const command = await npmServer("docker-langserver", ["dockerfile-language-server-nodejs"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "prisma",
		extensions: [".prisma"],
		rootMarkers: ["schema.prisma", "package.json"],
		resolve: async (root, ctx) => {
			const command = await npmServer("prisma-language-server", ["@prisma/language-server"], root, ctx);
			return command ? { command, args: ["--stdio"] } : undefined;
		},
	},
	{
		id: "csharp",
		extensions: [".cs", ".csx"],
		rootMarkers: [".sln", ".slnx", ".csproj", "global.json"],
		resolve: async (root) => {
			const roslyn = findBin("roslyn-language-server", root, [join(homedir(), ".dotnet", "tools")]);
			if (roslyn) return { command: roslyn, args: ["--stdio", "--autoLoadProjects"] };
			const csharpLs = findBin("csharp-ls", root, [join(homedir(), ".dotnet", "tools")]);
			return csharpLs ? { command: csharpLs, args: [] } : undefined;
		},
	},
	{
		id: "fsharp",
		extensions: [".fs", ".fsi", ".fsx", ".fsscript"],
		rootMarkers: [".sln", ".fsproj", "global.json"],
		resolve: pathServer("fsautocomplete", [], [join(homedir(), ".dotnet", "tools")]),
	},
	{
		id: "java",
		extensions: [".java"],
		rootMarkers: [
			"pom.xml",
			"build.gradle",
			"build.gradle.kts",
			"settings.gradle",
			"settings.gradle.kts",
			".project",
		],
		strictRoot: true,
		resolve: pathServer("jdtls", []),
	},
	{
		id: "kotlin",
		extensions: [".kt", ".kts"],
		rootMarkers: ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml"],
		resolve: async (root) => {
			const kls = findBin("kotlin-lsp", root) ?? findBin("kotlin-language-server", root);
			return kls ? { command: kls, args: kls.endsWith("kotlin-lsp") ? ["--stdio"] : [] } : undefined;
		},
	},
	{
		id: "swift",
		extensions: [".swift"],
		rootMarkers: ["Package.swift"],
		resolve: pathServer("sourcekit-lsp", []),
	},
	{
		id: "lua",
		extensions: [".lua"],
		rootMarkers: [".luarc.json", ".luarc.jsonc", ".stylua.toml", "stylua.toml"],
		resolve: releaseServer(
			"lua-language-server",
			{
				repo: "LuaLS/lua-language-server",
				asset: (os, arch) => new RegExp(`^lua-language-server-[\\d.]+-${os}-${arch}\\.(tar\\.gz|zip)$`),
				bin: "lua-language-server",
			},
			[],
		),
	},
	{
		id: "zls",
		extensions: [".zig", ".zon"],
		rootMarkers: ["build.zig"],
		resolve: releaseServer(
			"zls",
			{
				repo: "zigtools/zls",
				asset: (os, arch) => new RegExp(`^zls-${CPU_WORD[arch]}-${OS_WORD[os]}\\.(tar\\.xz|zip)$`),
				bin: "zls",
			},
			[],
		),
	},
	{
		id: "elixir",
		extensions: [".ex", ".exs"],
		rootMarkers: ["mix.exs", "mix.lock"],
		resolve: async (root) => {
			const ls = findBin("elixir-ls", root) ?? findBin("language_server.sh", root) ?? findBin("expert", root);
			return ls ? { command: ls, args: basename(ls) === "expert" ? ["--stdio"] : [] } : undefined;
		},
	},
	{
		id: "dart",
		extensions: [".dart"],
		rootMarkers: ["pubspec.yaml", "analysis_options.yaml"],
		resolve: pathServer("dart", ["language-server", "--lsp"]),
	},
	{
		id: "ocaml",
		extensions: [".ml", ".mli"],
		rootMarkers: ["dune-project", "dune-workspace", ".merlin", "opam"],
		resolve: pathServer("ocamllsp", []),
	},
	{
		id: "haskell",
		extensions: [".hs", ".lhs"],
		rootMarkers: ["stack.yaml", "cabal.project", "hie.yaml", "package.yaml"],
		resolve: pathServer("haskell-language-server-wrapper", ["--lsp"]),
	},
	{
		id: "gleam",
		extensions: [".gleam"],
		rootMarkers: ["gleam.toml"],
		resolve: pathServer("gleam", ["lsp"]),
	},
	{
		id: "clojure",
		extensions: [".clj", ".cljs", ".cljc", ".edn"],
		rootMarkers: ["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"],
		resolve: pathServer("clojure-lsp", ["listen"]),
	},
	{
		id: "nix",
		extensions: [".nix"],
		rootMarkers: ["flake.nix"],
		resolve: pathServer("nixd", []),
	},
	{
		id: "julia",
		extensions: [".jl"],
		rootMarkers: ["Project.toml", "Manifest.toml"],
		resolve: pathServer("julia", [
			"--startup-file=no",
			"--history-file=no",
			"-e",
			"using LanguageServer; runserver()",
		]),
	},
	{
		id: "terraform",
		extensions: [".tf", ".tfvars"],
		rootMarkers: [".terraform.lock.hcl", "terraform.tfstate"],
		resolve: async (root) => {
			const ls = findBin("terraform-ls", root);
			return ls
				? {
						command: ls,
						args: ["serve"],
						initializationOptions: {
							experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true },
						},
					}
				: undefined;
		},
	},
	{
		id: "latex",
		extensions: [".tex", ".bib"],
		rootMarkers: [".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"],
		resolve: releaseServer(
			"texlab",
			{
				repo: "latex-lsp/texlab",
				asset: (os, arch) => new RegExp(`^texlab-${CPU_WORD[arch]}-${OS_WORD[os]}\\.(tar\\.gz|zip)$`),
				bin: "texlab",
			},
			[],
		),
	},
	{
		id: "typst",
		extensions: [".typ", ".typc"],
		rootMarkers: ["typst.toml"],
		resolve: releaseServer(
			"tinymist",
			{
				repo: "Myriad-Dreamin/tinymist",
				asset: (os, arch) => new RegExp(`^tinymist-${CPU_WORD[arch]}-${TRIPLE[os]}\\.(tar\\.gz|zip)$`),
				bin: "tinymist",
			},
			[],
		),
	},
];

/** Whether a server handles this file, by extension or whole basename. */
export function handlesFile(def: Pick<ServerDef, "extensions">, file: string): boolean {
	return def.extensions.includes(extname(file).toLowerCase()) || def.extensions.includes(basename(file));
}

/**
 * The directory a server should treat as its workspace for `file`: the
 * nearest one (walking up, not above `boundary`) holding a root marker.
 * Undefined when the server doesn't apply: a strict root with no marker, or a
 * root that carries an exclude marker.
 */
export function rootFor(def: ServerDef, file: string, boundary: string): string | undefined {
	const stop = resolve(boundary);
	let dir = dirname(resolve(file));
	const within = dir === stop || dir.startsWith(`${stop}/`);
	while (true) {
		if (def.excludeMarkers?.some((m) => hasMarker(dir, m))) return undefined;
		if (def.rootMarkers.some((m) => hasMarker(dir, m))) return dir;
		if (dir === stop || !within) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (def.strictRoot) return undefined;
	return within ? stop : dirname(resolve(file));
}

/** A marker is a file name, or an extension (`.sln`) any file in the directory may carry. */
const EXTENSION_MARKERS = new Set([".sln", ".slnx", ".csproj", ".fsproj"]);

function hasMarker(dir: string, marker: string): boolean {
	if (!EXTENSION_MARKERS.has(marker)) return existsSync(join(dir, marker));
	try {
		return readdirSync(dir).some((name) => name.endsWith(marker));
	} catch {
		return false;
	}
}
