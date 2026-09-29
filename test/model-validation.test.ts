import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { createClient, streamAndCollect } from "../src/core/llm.ts";
import {
	forgetValidated,
	MODEL_VALIDATION_TTL_MS,
	recentlyValidated,
	rememberValidated,
} from "../src/core/model-validation.ts";

let home = "";
let realHome: string | undefined;
beforeEach(() => {
	realHome = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "cast-validation-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

const connection = { baseURL: "https://provider.example/v1", apiKey: "sk-secret" };

describe("model validation cache", () => {
	it("remembers a passed check for a day", () => {
		const now = 1_000_000_000_000;
		expect(recentlyValidated(connection, "m", now)).toBe(false);
		rememberValidated(connection, "m", now);
		expect(recentlyValidated(connection, "m", now + MODEL_VALIDATION_TTL_MS - 1)).toBe(true);
		expect(recentlyValidated(connection, "m", now + MODEL_VALIDATION_TTL_MS)).toBe(false);
	});

	it("is per provider, key and model, and never stores the key", () => {
		rememberValidated(connection, "m");
		expect(recentlyValidated({ ...connection, apiKey: "sk-other" }, "m")).toBe(false);
		expect(recentlyValidated({ ...connection, baseURL: "https://other.example/v1" }, "m")).toBe(false);
		expect(recentlyValidated(connection, "m2")).toBe(false);
		expect(readFileSync(join(home, ".cast", "cache", "validated-models.json"), "utf-8")).not.toContain("sk-secret");
	});

	it("forgets an entry", () => {
		rememberValidated(connection, "m");
		forgetValidated(connection, "m");
		expect(recentlyValidated(connection, "m")).toBe(false);
	});

	it("is forgotten when the provider rejects the key", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "invalid api key" } }));
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		const config = { baseURL, apiKey: "sk-revoked", maxResponseTokens: 100 } as AppConfig;
		rememberValidated(config, "m");
		try {
			await expect(
				streamAndCollect(createClient(config), "m", [{ role: "user", content: "hi" }], [], 10),
			).rejects.toThrow();
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
		expect(recentlyValidated(config, "m")).toBe(false);
	});
});
