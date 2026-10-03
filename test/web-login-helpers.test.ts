import { describe, expect, it } from "vitest";
import { loginDestination, waitText } from "../src/server/public/login-helpers.js";

const origin = "http://127.0.0.1:4802";

describe("loginDestination", () => {
	it("goes back to the path the person was headed to, with its query and hash", () => {
		expect(loginDestination("?next=%2F%3Fsession%3Dabc", origin)).toBe("/?session=abc");
		expect(loginDestination("?next=/dashboard%3Ftab%3D2%23top", origin)).toBe("/dashboard?tab=2#top");
		expect(loginDestination("?next=http%3A%2F%2F127.0.0.1%3A4802%2Fx", origin)).toBe("/x");
	});

	it("falls back to the root without a next", () => {
		expect(loginDestination("", origin)).toBe("/");
		expect(loginDestination("?next=", origin)).toBe("/");
	});

	it("never leaves the site, including by a character the URL parser drops", () => {
		for (const next of [
			"//evil.test/x",
			"/\\evil.test/x",
			"/\t/evil.test/x",
			"/\n/evil.test/x",
			"/%09/evil.test/x",
			"https://evil.test/x",
			"http://127.0.0.1:4803/x",
			"javascript:alert(1)",
		]) {
			const result = loginDestination(`?next=${encodeURIComponent(next)}`, origin);
			expect(new URL(result, origin).origin, next).toBe(origin);
		}
		expect(loginDestination("?next=/%09/evil.test/x", origin)).toBe("/");
	});
});

describe("waitText", () => {
	it("says how long to wait in seconds or minutes", () => {
		expect(waitText(30)).toBe("30 seconds");
		expect(waitText(60)).toBe("1 minute");
		expect(waitText(61)).toBe("2 minutes");
		expect(waitText(898)).toBe("15 minutes");
		expect(waitText(Number.NaN)).toBe("a while");
		expect(waitText(0)).toBe("a while");
	});
});
