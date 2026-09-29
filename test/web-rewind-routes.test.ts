import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

let server: ReturnType<typeof startServer>;
let origin = "";
let cookie = "";
let commands: string[];
let reply: { ok: boolean; result?: unknown; error?: string };

beforeEach(async () => {
	commands = [];
	reply = { ok: true, result: "Rewound: files and conversation (1 turn)" };
	const bridge = {
		rewindPoints: (id: string) => (id === "s1" ? [3, 9] : undefined),
		previewRewind: async (id: string, userSeq: number) =>
			id === "s1" ? { available: true, message: `m${userSeq}` } : undefined,
		executeCommand: async (_id: string, command: string) => {
			commands.push(command);
			return reply;
		},
	} as unknown as ServerBridge;
	server = startServer({ port: 0, host: "127.0.0.1", bridge, webUser: "cast", serverPassword: "pw", version: "test" });
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
});

const get = (path: string) => fetch(`${origin}/api/sessions/${path}`, { headers: { Cookie: cookie } });
const post = (body: unknown) =>
	fetch(`${origin}/api/sessions/s1/rewind`, {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

describe("rewind routes", () => {
	it("lists the messages that can be rewound to", async () => {
		expect(await (await get("s1/rewind-points")).json()).toEqual({ userSeqs: [3, 9] });
		expect((await get("nope/rewind-points")).status).toBe(404);
	});

	it("previews, and refuses a missing or non-integer seq", async () => {
		expect(await (await get("s1/rewind?userSeq=3")).json()).toEqual({ available: true, message: "m3" });
		expect((await get("nope/rewind?userSeq=3")).status).toBe(404);
		expect((await get("s1/rewind")).status).toBe(400);
		expect((await get("s1/rewind?userSeq=x")).status).toBe(400);
	});

	it("turns a request into the /rewind command", async () => {
		expect((await post({ userSeq: 3 })).status).toBe(200);
		expect((await post({ userSeq: 3, mode: "code", force: true })).status).toBe(200);
		expect(commands).toEqual(["/rewind 3 both", "/rewind 3 code --force"]);
	});

	it("rejects a malformed request without running anything", async () => {
		expect((await post({})).status).toBe(400);
		expect((await post({ userSeq: 1.5 })).status).toBe(400);
		expect((await post({ userSeq: 3, mode: "sideways" })).status).toBe(400);
		expect((await post({ userSeq: 3, force: "yes" })).status).toBe(400);
		expect(commands).toEqual([]);
	});

	it("maps a refusal to a conflict when files would be deleted or the agent is busy, else a bad request", async () => {
		reply = {
			ok: false,
			error: "Rewinding would delete 2 file(s) created since (a, b). Re-run with --force to proceed.",
		};
		expect((await post({ userSeq: 3 })).status).toBe(409);
		reply = { ok: false, error: "Agent running — use /queue, /steer, or /abort" };
		expect((await post({ userSeq: 3 })).status).toBe(409);
		reply = { ok: false, error: "There is no snapshot for that message" };
		expect((await post({ userSeq: 3 })).status).toBe(400);
	});
});
