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

	describe("scoped to a directory", () => {
		let other: string;
		beforeEach(() => {
			other = join(fakeHome, "elsewhere");
			mkdirSync(other, { recursive: true });
		});

		const seed = () => {
			const mine = createSession("gpt-4o", project);
			mine.messages.push({ role: "user", content: "alpha work in this project" });
			saveSession(mine);
			const theirs = createSession("gpt-4o", other);
			theirs.messages.push({ role: "user", content: "alpha work somewhere else" });
			saveSession(theirs);
			return { mine, theirs };
		};
		const resumeRows = (options: PickOption<unknown>[]) =>
			options
				.filter((o) => (o.value as { action?: string }).action === "resume")
				.map((o) => (o.value as { id: string }).id);
		const action = (options: PickOption<unknown>[], name: string) =>
			options.find((o) => (o.value as { action?: string }).action === name);

		it("lists this directory's sessions first, with a way to show all", async () => {
			const { mine } = seed();
			let title: string | undefined;
			const pickers = fakePickers((options, opts) => {
				title = opts?.title;
				expect(resumeRows(options)).toEqual([mine.id]);
				expect(action(options, "all")?.label).toContain("Show all sessions (2)");
				expect(action(options, "here")).toBeUndefined();
				return options.find((o) => (o.value as { id?: string }).id === mine.id)!.value;
			});
			const resumed = await selectSession(pickers, { cwd: project });
			expect(resumed?.id).toBe(mine.id);
			expect(title).toContain("Sessions in");
		});

		it("'Show all sessions' lists every directory's, and can go back to this one", async () => {
			const { mine, theirs } = seed();
			const seen: string[][] = [];
			let call = 0;
			const pickers = fakePickers((options, opts) => {
				seen.push(resumeRows(options));
				call++;
				if (call === 1) return action(options, "all")!.value;
				if (call === 2) {
					expect(opts?.title).toContain("All sessions");
					expect(action(options, "here")?.label).toContain("Only this directory (1)");
					return action(options, "here")!.value;
				}
				return options.find((o) => (o.value as { id?: string }).id === mine.id)!.value;
			});
			const resumed = await selectSession(pickers, { cwd: project });
			expect(resumed?.id).toBe(mine.id);
			expect(seen[0]).toEqual([mine.id]);
			expect(new Set(seen[1])).toEqual(new Set([mine.id, theirs.id]));
			expect(seen[2]).toEqual([mine.id]);
		});

		it("offers the other view as the picker's switch key, in both directions", async () => {
			seed();
			const switches: Array<{ to: unknown; hint?: string }> = [];
			let call = 0;
			await selectSession(
				fakePickers((options, opts) => {
					switches.push({ to: opts?.switchTo, hint: opts?.switchHint });
					call++;
					return call === 1 ? opts?.switchTo : null;
				}),
				{ cwd: project },
			);
			expect(switches[0]).toEqual({ to: expect.objectContaining({ action: "all" }), hint: "all sessions" });
			expect(switches[1]).toEqual({ to: expect.objectContaining({ action: "here" }), hint: "this directory" });
		});

		it("has no switch key when there is nothing to switch between", async () => {
			seed();
			let seen: unknown = "unset";
			await selectSession(
				fakePickers((_options, opts) => {
					seen = opts?.switchTo;
					return null;
				}),
			);
			expect(seen).toBeUndefined();
		});

		it("searches within the scope it is in", async () => {
			const { mine, theirs } = seed();
			let search: ((q: string) => PickOption<unknown>[]) | undefined;
			await selectSession(
				fakePickers((_options, opts) => {
					search = opts?.search?.dynamicSearch as typeof search;
					return null;
				}),
				{ cwd: project },
			);
			const ids = (search?.("alpha") ?? []).map((o) => (o.value as { id?: string }).id);
			expect(ids).toContain(mine.id);
			expect(ids).not.toContain(theirs.id);
		});

		it("shows everything, and says so, when this directory has none yet", async () => {
			const { theirs } = seed();
			const logged: string[] = [];
			const pickers: Pickers = {
				...fakePickers((options) => {
					expect(resumeRows(options)).toContain(theirs.id);
					expect(action(options, "here")).toBeUndefined();
					return null;
				}),
				log: (text) => logged.push(text),
			};
			const empty = join(fakeHome, "empty");
			mkdirSync(empty);
			await selectSession(pickers, { cwd: empty });
			expect(logged.join("\n")).toContain("No sessions in this directory yet");
		});

		it("leaves out sessions with no messages, which have nothing to go back to", async () => {
			const { mine } = seed();
			saveSession(createSession("gpt-4o", project));
			await selectSession(
				fakePickers((options) => {
					expect(resumeRows(options)).toEqual([mine.id]);
					return null;
				}),
				{ cwd: project },
			);
		});

		it("is the old list of everything when no directory is given", async () => {
			const { mine, theirs } = seed();
			await selectSession(
				fakePickers((options) => {
					expect(new Set(resumeRows(options))).toEqual(new Set([mine.id, theirs.id]));
					expect(action(options, "all")).toBeUndefined();
					return null;
				}),
			);
		});
	});
});
