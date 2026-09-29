import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidateProjectFiles } from "../src/core/file-search.ts";
import type { ServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

let server: ReturnType<typeof startServer>;
let origin = "";
let project = "";
let outside = "";
let cookie = "";
const SID = "s1";

beforeEach(async () => {
	project = mkdtempSync(join(tmpdir(), "cast-fsroutes-"));
	outside = mkdtempSync(join(tmpdir(), "cast-fsroutes-out-"));
	const bridge = {
		getSession: (id: string) => (id === SID ? { session: { cwd: project } } : undefined),
		getConfig: () => ({ cwd: project }),
	} as unknown as ServerBridge;
	server = startServer({
		port: 0,
		host: "127.0.0.1",
		bridge,
		webUser: "cast",
		serverPassword: "pw",
		version: "test",
	});
	await once(server, "listening");
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const login = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "cast", password: "pw" }),
	});
	cookie = login.headers.get("set-cookie") ?? "";
});

afterEach(async () => {
	server.close();
	await once(server, "close");
	invalidateProjectFiles(project);
	rmSync(project, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const url = (path: string) => `${origin}/api/sessions/${SID}${path}`;
const get = (path: string, headers: Record<string, string> = {}) =>
	fetch(url(path), { headers: { Cookie: cookie, ...headers } });
const send = (method: string, path: string, body?: unknown) =>
	fetch(url(path), {
		method,
		headers: { Cookie: cookie, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

describe("listing and search", () => {
	it("pages a directory", async () => {
		for (let i = 0; i < 5; i++) writeFileSync(join(project, `f${i}.txt`), "x");
		const page = (await (await get("/fs?path=.&limit=2&offset=2")).json()) as {
			entries: { name: string }[];
			total: number;
			hasMore: boolean;
		};
		expect(page.entries.map((e) => e.name)).toEqual(["f2.txt", "f3.txt"]);
		expect(page).toMatchObject({ total: 5, hasMore: true });
	});

	it("finds files and folders by every word, and reports truncation", async () => {
		mkdirSync(join(project, "test"));
		for (let i = 0; i < 3; i++) writeFileSync(join(project, "test", `lsp-${i}.test.ts`), "x");
		const found = (await (await get("/fs/search?q=lsp%20test")).json()) as {
			results: { path: string }[];
			total: number;
		};
		expect(found.total).toBe(3);
		expect(found.results[0]?.path).toMatch(/^test\/lsp-\d\.test\.ts$/);
	});

	it("searches ignored files only when asked", async () => {
		execFileSync("git", ["init", "-q"], { cwd: project });
		writeFileSync(join(project, ".gitignore"), "vendor/\n");
		mkdirSync(join(project, "vendor"));
		writeFileSync(join(project, "vendor", "needle.js"), "x");
		const plain = (await (await get("/fs/search?q=needle")).json()) as { total: number };
		const all = (await (await get("/fs/search?q=needle&ignored=1")).json()) as { total: number };
		expect([plain.total, all.total]).toEqual([0, 1]);
	});

	it("404s an unknown session", async () => {
		const res = await fetch(`${origin}/api/sessions/nope/fs`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(404);
	});
});

describe("mutations", () => {
	it("creates, renames, moves and batch-deletes", async () => {
		expect((await send("POST", "/fs/create", { path: "", name: "a/b.txt", type: "file" })).status).toBe(201);
		expect((await send("POST", "/fs/create", { path: "", name: "a/b.txt", type: "file" })).status).toBe(409);
		expect((await send("POST", "/fs/create", { path: "", name: "dest", type: "dir" })).status).toBe(201);
		expect((await send("POST", "/fs/rename", { path: "a/b.txt", name: "c.txt" })).status).toBe(200);
		expect((await send("POST", "/fs/move", { path: "a/c.txt", to: "dest" })).status).toBe(200);
		expect(existsSync(join(project, "dest", "c.txt"))).toBe(true);
		const res = await send("POST", "/fs/delete", { paths: ["dest/c.txt", "missing", ".git"] });
		const body = (await res.json()) as { deleted: string[]; failed: { path: string }[] };
		expect(body.deleted).toEqual(["dest/c.txt"]);
		expect(body.failed.map((f) => f.path).sort()).toEqual([".git", "missing"]);
	});

	it("keeps a created file findable at once, not after the index cache expires", async () => {
		await get("/fs/search?q=fresh");
		await send("POST", "/fs/create", { path: "", name: "fresh-file.txt", type: "file" });
		const found = (await (await get("/fs/search?q=fresh")).json()) as { total: number };
		expect(found.total).toBe(1);
	});

	it("refuses to leave the project", async () => {
		symlinkSync(outside, join(project, "escape"));
		expect((await send("POST", "/fs/create", { path: "escape", name: "evil.txt", type: "file" })).status).toBe(400);
		expect((await send("POST", "/fs/move", { path: "..", to: "" })).status).toBeGreaterThanOrEqual(400);
		expect((await get("/fs?path=escape")).status).toBe(400);
	});
});

describe("upload and download", () => {
	const put = (path: string, body: string, query = "") =>
		fetch(url(`/fs/upload?path=${encodeURIComponent(path)}${query}`), {
			method: "PUT",
			headers: { Cookie: cookie },
			body,
		});

	it("uploads, refuses an existing file and overwrites on request", async () => {
		expect((await put("dir/up.txt", "one")).status).toBe(201);
		expect(readFileSync(join(project, "dir", "up.txt"), "utf-8")).toBe("one");
		expect((await put("dir/up.txt", "two")).status).toBe(409);
		expect((await put("dir/up.txt", "two", "&overwrite=1")).status).toBe(201);
		expect(readFileSync(join(project, "dir", "up.txt"), "utf-8")).toBe("two");
	});

	it("serves a byte range and rejects one past the end", async () => {
		writeFileSync(join(project, "r.txt"), "0123456789");
		const part = await get("/fs/download?path=r.txt", { Range: "bytes=2-4" });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("234");
		expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
		expect((await get("/fs/download?path=r.txt", { Range: "bytes=50-" })).status).toBe(416);
	});

	it("streams a folder as a tar.gz", async () => {
		mkdirSync(join(project, "pack"));
		writeFileSync(join(project, "pack", "in.txt"), "x");
		const res = await get("/fs/download?path=pack");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/gzip");
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
	});
});

describe("/diff", () => {
	it("lists a change without a diff body past the cap, and loads one file on demand", async () => {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
		execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: project });
		execFileSync("git", ["config", "user.name", "T"], { cwd: project });
		writeFileSync(join(project, "a.txt"), "one\n");
		execFileSync("git", ["add", "a.txt"], { cwd: project });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: project });
		writeFileSync(join(project, "a.txt"), "one\ntwo\n");

		const diff = (await (await get("/diff")).json()) as { groups: { modified: string[] }; files: { path: string }[] };
		expect(diff.groups.modified).toEqual(["a.txt"]);
		const one = (await (await get("/diff/file?path=a.txt")).json()) as {
			files: { path: string; additions: number }[];
		};
		expect(one.files[0]).toMatchObject({ path: "a.txt", additions: 1 });
		expect((await get("/diff/file?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(400);
	});
});
