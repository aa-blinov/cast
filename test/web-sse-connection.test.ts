import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeSseConnection, openSseConnection } from "../src/server/public/sse-connection.js";

describe("web SSE connection", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"EventSource",
			class {
				url: string;
				close = vi.fn();
				onopen?: () => void;
				onmessage?: (event: MessageEvent) => void;
				onerror?: () => void;

				constructor(url: string) {
					this.url = url;
				}
			},
		);
	});

	it("configures handlers and closes the source through the shared lifecycle", () => {
		const onOpen = vi.fn();
		const onMessage = vi.fn();
		const onError = vi.fn();
		const source = openSseConnection("/events", { onOpen, onMessage, onError });

		expect(source.url).toBe("/events");
		expect(source.onopen).toBe(onOpen);
		expect(source.onmessage).toBe(onMessage);
		expect(source.onerror).toBe(onError);

		closeSseConnection(source);
		expect(source.close).toHaveBeenCalledOnce();
	});

	it("accepts an empty connection configuration", () => {
		expect(() => openSseConnection("/events")).not.toThrow();
		expect(() => closeSseConnection(null)).not.toThrow();
	});
});
