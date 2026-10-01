import { describe, expect, it } from "vitest";
import { type ServerDaemonState, yieldsToRegisteredDaemon } from "../src/server/daemon-state.ts";

const other = { pid: 100, port: 1, host: "127.0.0.1" } as ServerDaemonState;

describe("yieldsToRegisteredDaemon", () => {
	it("makes a daemon started by `cast server start` give way to one that is already registered", () => {
		expect(yieldsToRegisteredDaemon(other, 200, { CAST_SERVER_FOREGROUND: "0" })).toBe(true);
	});

	it("keeps a dev-mode, test or foreground instance serving, as designed", () => {
		expect(yieldsToRegisteredDaemon(other, 200, {})).toBe(false);
		expect(yieldsToRegisteredDaemon(other, 200, { CAST_SERVER_FOREGROUND: "1" })).toBe(false);
	});

	it("does not give way to itself or to nobody", () => {
		expect(yieldsToRegisteredDaemon(other, 100, { CAST_SERVER_FOREGROUND: "0" })).toBe(false);
		expect(yieldsToRegisteredDaemon(undefined, 200, { CAST_SERVER_FOREGROUND: "0" })).toBe(false);
	});
});
