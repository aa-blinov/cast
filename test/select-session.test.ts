import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, saveSession } from "../src/core/session.ts";
import { selectSession } from "../src/pickers/domain.ts";
import type { Pickers, PickOption, PickOptions } from "../src/pickers/types.ts";

// selectSession now runs the picker off lightweight summaries and only parses
// the chosen session's file — these tests pin that contract: the returned
// object must still be the FULL session (messages included), and the picker
// must receive a dynamicSearch callback backed by the SQLite FTS index
// (core/session.ts's searchSessionSummaries) instead of per-row haystack text.

describe("selectSession over summaries", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let project: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-select-session-"));
		process.env.HOME = fakeHome;
		project = join(fakeHome, "proj");
		mkdirSync(project, { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	function fakePickers(pick: (options: PickOption<unknown>[], opts?: PickOptions) => unknown): Pickers {
		return {
			pickOption: async (options, opts) => pick(options as PickOption<unknown>[], opts) as never,
			promptText: async () => null,
			pickMulti: async () => null,
			log: () => {},
		};
	}

	it("returns the full session (with messages) for the picked row", async () => {
		const s = createSession("gpt-4o", project);
		s.messages.push({ role: "user", content: "the real payload" });
		saveSession(s);

		let sawSearch: unknown;
		const pickers = fakePickers((options, opts) => {
			sawSearch = opts?.search;
			const row = options.find((o) => (o.value as { action?: string }).action === "resume")!;
			return row.value;
		});

		const resumed = await selectSession(pickers);
		expect(resumed?.id).toBe(s.id);
		// Not a summary — the actual message bodies must be there.
		expect(resumed?.messages.some((m) => m.content === "the real payload")).toBe(true);
		// The picker ran in search mode, backed by a live FTS query rather than
		// a precomputed haystack string — dynamicSearch itself must find the
		// same row by message content.
		expect(sawSearch).toBeTruthy();
		const dynamicSearch = (sawSearch as { dynamicSearch?: (q: string) => PickOption<unknown>[] })?.dynamicSearch;
		const hits = dynamicSearch?.("the real payload") ?? [];
		expect(hits.some((o) => (o.value as { id?: string }).id === s.id)).toBe(true);
	});

	it("returns null on cancel and on 'Start fresh'", async () => {
		const s = createSession("gpt-4o", project);
		saveSession(s);
		expect(await selectSession(fakePickers(() => null))).toBeNull();
		expect(
			await selectSession(
				fakePickers((options) => options.find((o) => (o.value as { action?: string }).action === "fresh")!.value),
			),
		).toBeNull();
	});
});
