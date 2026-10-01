import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/core/settings.ts";
import { canBind, rememberBind, rememberedBind } from "../src/server/daemon-bind.ts";

describe("daemon bind", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	const servers: Server[] = [];

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-bind-test-"));
		process.env.HOME = fakeHome;
	});

	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("remembers nothing until an address was chosen", () => {
		expect(rememberedBind()).toBeUndefined();
	});

	it("remembers a public address, so a daemon started later can bind it too", () => {
		rememberBind({ host: "0.0.0.0", port: 1337 });
		expect(rememberedBind()).toEqual({ host: "0.0.0.0", port: 1337 });
		expect(loadSettings().serverBind).toEqual({ host: "0.0.0.0", port: 1337 });
	});

	it("forgets it when the private default is chosen again", () => {
		rememberBind({ host: "0.0.0.0", port: 1337 });
		rememberBind({ host: "127.0.0.1", port: 0 });
		expect(rememberedBind()).toBeUndefined();
		expect(loadSettings().serverBind).toBeUndefined();
	});

	it("keeps a fixed loopback port, which is a choice too", () => {
		rememberBind({ host: "127.0.0.1", port: 4000 });
		expect(rememberedBind()).toEqual({ host: "127.0.0.1", port: 4000 });
	});

	it("says whether an address is free, so a port taken by something else falls back to private", async () => {
		const taken = createServer();
		servers.push(taken);
		await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
		const port = (taken.address() as { port: number }).port;
		expect(await canBind({ host: "127.0.0.1", port })).toBe(false);
		taken.close();
		servers.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await canBind({ host: "127.0.0.1", port })).toBe(true);
		expect(await canBind({ host: "127.0.0.1", port: 0 })).toBe(true);
	});
});
