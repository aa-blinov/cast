import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeConfirmBash } from "../src/core/project.ts";
import type { Pickers, PickOption, PickOptions } from "../src/pickers/types.ts";

describe("makeConfirmBash", () => {
	let isTTY: boolean | undefined;
	beforeEach(() => {
		isTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});
	afterEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
	});

	const asking = (answer: string | null) => {
		const seen: { options?: PickOption<unknown>[]; opts?: PickOptions<unknown> } = {};
		const pickers: Pickers = {
			promptText: async () => null,
			pickMulti: async () => null,
			log: () => {},
			pickOption: (async (options: PickOption<unknown>[], opts?: PickOptions<unknown>) => {
				seen.options = options;
				seen.opts = opts;
				return answer;
			}) as Pickers["pickOption"],
		};
		return { pickers, seen };
	};

	it("puts the command and the reason in the question itself, not only in a notice behind it", async () => {
		const { pickers, seen } = asking("block");
		await makeConfirmBash(pickers, "default")("rm -rf build", "recursive delete");
		expect(seen.opts?.detail).toBe("recursive delete\nrm -rf build");
		expect(seen.opts?.title).toBe("Allow this?");
	});

	it("answers to y, a and n, and says so on the rows", async () => {
		const { pickers, seen } = asking("block");
		await makeConfirmBash(pickers, "default")("rm -rf build", "recursive delete");
		expect(seen.options?.map((o) => [o.key, o.value])).toEqual([
			["y", "once"],
			["a", "always"],
			["n", "block"],
		]);
		expect(seen.options?.map((o) => o.label.slice(0, 14))).toEqual(["Allow once (y)", "Always allow (", "Block (n)"]);
	});

	it("lets the command run on `once` and stops it on `block` or a dismissed question", async () => {
		expect(await makeConfirmBash(asking("once").pickers, "default")("ls", "r")).toBe(true);
		expect(await makeConfirmBash(asking("block").pickers, "default")("ls", "r")).toBe(false);
		expect(await makeConfirmBash(asking(null).pickers, "default")("ls", "r")).toBe(false);
	});

	it("does not ask at all in bypass mode", async () => {
		const { pickers, seen } = asking("block");
		expect(await makeConfirmBash(pickers, "bypass")("rm -rf /", "r")).toBe(true);
		expect(seen.options).toBeUndefined();
	});
});
