import { createElement, useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { createStore, mountHeadless } from "../src/ui-pi/headless.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("mountHeadless", () => {
	it("runs a component's hooks with nothing to draw, and what they produce reaches the store", async () => {
		const store = createStore<{ count: number }>();
		let bump: () => void = () => {};
		function Model() {
			const [count, setCount] = useState(0);
			bump = () => setCount((n) => n + 1);
			useEffect(() => {
				store.set({ count });
			});
			return null;
		}
		const seen: number[] = [];
		store.subscribe((value) => seen.push(value.count));
		const root = mountHeadless(createElement(Model), (error) => {
			throw error;
		});
		await tick();
		bump();
		await tick();
		bump();
		await tick();
		expect(seen).toEqual([0, 1, 2]);
		expect(store.get()).toEqual({ count: 2 });
		root.unmount();
	});

	it("runs effects' cleanups on unmount", async () => {
		let cleaned = false;
		function Model() {
			useEffect(
				() => () => {
					cleaned = true;
				},
				[],
			);
			return null;
		}
		const root = mountHeadless(createElement(Model), () => {});
		await tick();
		root.unmount();
		await tick();
		expect(cleaned).toBe(true);
	});

	it("hands a render error to the caller instead of losing it", async () => {
		const errors: string[] = [];
		function Broken(): null {
			throw new Error("boom");
		}
		mountHeadless(createElement(Broken), (error) => errors.push(error.message));
		await tick();
		expect(errors).toContain("boom");
	});
});

describe("createStore", () => {
	it("lets a subscriber go", () => {
		const store = createStore<number>();
		const seen: number[] = [];
		const stop = store.subscribe((value) => seen.push(value));
		store.set(1);
		stop();
		store.set(2);
		expect(seen).toEqual([1]);
	});
});
