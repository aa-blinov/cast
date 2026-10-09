import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeMcpConnections, connectMcpServers } from "../src/core/mcp.ts";
import {
	authorizationCodeFrom,
	clearMcpLogin,
	finishMcpLogin,
	hasMcpLogin,
	startMcpLogin,
} from "../src/core/mcp-auth.ts";

const EXAMPLE_SERVER = join(
	import.meta.dirname,
	"..",
	"node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js",
);

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

/** What a browser does with the authorization address: the server approves and redirects to the callback address. */
async function approve(authorizationUrl: string): Promise<string> {
	const res = await fetch(authorizationUrl, { redirect: "manual" });
	const location = res.headers.get("location");
	if (!location) throw new Error(`the server did not redirect (HTTP ${res.status})`);
	return location;
}

describe("MCP OAuth (the SDK's own OAuth MCP server, spawned, not mocked)", () => {
	let server: ChildProcess;
	let url: string;
	let home: string;
	const realHome = process.env.HOME;

	beforeAll(async () => {
		const [mcpPort, authPort] = [await freePort(), await freePort()];
		url = `http://localhost:${mcpPort}/mcp`;
		server = spawn("node", [EXAMPLE_SERVER, "--oauth"], {
			env: { ...process.env, MCP_PORT: String(mcpPort), MCP_AUTH_PORT: String(authPort) },
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			let out = "";
			server.stdout!.on("data", (chunk: Buffer) => {
				out += chunk.toString();
				if (out.includes(`port ${mcpPort}`) && out.includes(`port ${authPort}`)) resolve();
			});
			server.once("exit", () => reject(new Error("the OAuth example server exited early")));
		});
	}, 30_000);

	afterAll(() => {
		server?.kill();
		process.env.HOME = realHome;
	});

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cast-mcp-auth-"));
		process.env.HOME = home;
		return () => rmSync(home, { recursive: true, force: true });
	});

	it("tells where to sign in when a server answers 401", async () => {
		const result = await connectMcpServers({ guarded: { url } });
		expect(result.connections).toEqual([]);
		expect(result.diagnostics[0]).toMatch(/401/);
		expect(result.diagnostics[0]).toContain("run /mcp auth guarded");
	}, 30_000);

	it("does not offer OAuth when an Authorization header is set: that 401 is a bad token", async () => {
		const result = await connectMcpServers({ guarded: { url, headers: { Authorization: "Bearer nope" } } });
		expect(result.diagnostics[0]).not.toContain("/mcp auth");
	}, 30_000);

	it("signs in through the loopback address, connects with the login, and keeps the file private", async () => {
		const port = await freePort();
		const login = await startMcpLogin("guarded", url, undefined, undefined, port);
		expect(login.authorizationUrl).toContain("/authorize?");
		const callback = await approve(login.authorizationUrl);
		expect(callback.startsWith(`http://127.0.0.1:${port}/callback`)).toBe(true);
		expect((await fetch(callback)).status).toBe(200);
		await login.done;

		expect(hasMcpLogin("guarded", url)).toBe(true);
		expect(statSync(join(home, ".cast", "mcp-auth.json")).mode & 0o777).toBe(0o600);
		const result = await connectMcpServers({ guarded: { url } });
		try {
			expect(result.diagnostics).toEqual([]);
			expect(result.connections.map((c) => [c.serverName, c.alive])).toEqual([["guarded", true]]);
			expect(result.toolIndex.has("mcp_guarded_greet")).toBe(true);
		} finally {
			await closeMcpConnections(result.connections);
		}
	}, 30_000);

	it("finishes from a pasted address when the browser was on another machine", async () => {
		const port = await freePort();
		const reconnected: string[] = [];
		const login = await startMcpLogin("guarded", url, undefined, async () => void reconnected.push("guarded"), port);
		const landed = await approve(login.authorizationUrl);
		await finishMcpLogin("guarded", landed);
		await login.done;
		expect(hasMcpLogin("guarded", url)).toBe(true);
		expect(reconnected).toEqual(["guarded"]);
	}, 30_000);

	it("refuses a pasted address from another attempt, and keeps waiting", async () => {
		const port = await freePort();
		const login = await startMcpLogin("guarded", url, undefined, undefined, port);
		await expect(finishMcpLogin("guarded", "http://127.0.0.1/callback?code=abc&state=someone-elses")).rejects.toThrow(
			/different login attempt/,
		);
		const landed = await approve(login.authorizationUrl);
		await finishMcpLogin("guarded", landed);
		await login.done;
		expect(hasMcpLogin("guarded", url)).toBe(true);
	}, 30_000);

	it("forgets a login on request, and a login for another address is not reused", async () => {
		const port = await freePort();
		const login = await startMcpLogin("guarded", url, undefined, undefined, port);
		await finishMcpLogin("guarded", await approve(login.authorizationUrl));
		await login.done;
		expect(hasMcpLogin("guarded", `${url}/elsewhere`)).toBe(false);
		expect(clearMcpLogin("guarded")).toBe(true);
		expect(hasMcpLogin("guarded", url)).toBe(false);
		expect(clearMcpLogin("guarded")).toBe(false);
		expect(existsSync(join(home, ".cast", "mcp-auth.json"))).toBe(true);
	}, 30_000);

	it("says so when no login is waiting", async () => {
		await expect(finishMcpLogin("nobody", "abc")).rejects.toThrow(/No login is waiting/);
	});
});

describe("authorizationCodeFrom", () => {
	it("takes a bare code as it is", () => {
		expect(authorizationCodeFrom("  abc123 ", "s")).toBe("abc123");
	});

	it("reads the code out of the address the browser ended at", () => {
		expect(authorizationCodeFrom("http://127.0.0.1:33418/callback?code=abc&state=s", "s")).toBe("abc");
		expect(authorizationCodeFrom("?code=abc&state=s#frag", "s")).toBe("abc");
	});

	it("refuses another attempt's state, an error answer and a missing code", () => {
		expect(() => authorizationCodeFrom("?code=abc&state=x", "s")).toThrow(/different login attempt/);
		expect(() => authorizationCodeFrom("?error=access_denied&error_description=No+thanks", "s")).toThrow(/No thanks/);
		expect(() => authorizationCodeFrom("?state=s", "s")).toThrow(/No authorization code/);
	});
});

describe("the token file under concurrent writers", () => {
	it("keeps every server's entry when processes save at the same moment", async () => {
		const home = mkdtempSync(join(tmpdir(), "cast-auth-race-home-"));
		const work = mkdtempSync(join(tmpdir(), "cast-auth-race-work-"));
		const go = join(work, "go");
		const script = join(work, "save.ts");
		const authModule = join(import.meta.dirname, "..", "src", "core", "mcp-auth.ts");
		// Each child waits for the go file so the saves overlap; without the lock the token file loses entries.
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
import { createMcpAuthProvider } from ${JSON.stringify(authModule)};
const [name, go] = process.argv.slice(2);
while (!existsSync(go)) {
	// wait for the others
}
createMcpAuthProvider(name, "http://127.0.0.1/" + name).saveTokens({ access_token: name, token_type: "bearer" });
`,
		);
		const names = Array.from({ length: 8 }, (_, i) => `srv${i}`);
		try {
			const children = names.map(
				(name) =>
					new Promise<number | null>((resolve) => {
						const child = spawn(process.execPath, ["--import", "tsx", script, name, go], {
							cwd: join(import.meta.dirname, ".."),
							env: { ...process.env, HOME: home },
							stdio: "ignore",
						});
						child.on("exit", (code) => resolve(code));
					}),
			);
			// Give every child time to start and reach its wait loop before the go file lets them run.
			await new Promise((resolve) => setTimeout(resolve, 4_000));
			writeFileSync(go, "");
			expect(await Promise.all(children)).toEqual(names.map(() => 0));
			const saved = JSON.parse(readFileSync(join(home, ".cast", "mcp-auth.json"), "utf-8")) as Record<
				string,
				unknown
			>;
			expect(Object.keys(saved).sort()).toEqual([...names].sort());
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(work, { recursive: true, force: true });
		}
	}, 60_000);
});
