import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchUrlLocal } from "../src/core/tools/web.ts";

/**
 * The local web_fetch backend through a real connection: undici's fetch, its pinned dispatcher, redirects done by hand.
 * Every other test of it stands in for the network, which is how it came to fail on every request for a long time
 * (a package Agent handed to Node's own fetch: "invalid onRequestStart method") with a green suite.
 */
describe("fetchUrlLocal over a real connection", () => {
	let server: Server;
	let port: number;
	const hits: string[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			hits.push(`${req.method} ${req.url} ua=${req.headers["user-agent"]?.slice(0, 7)}`);
			if (req.url === "/redirect") {
				res.writeHead(302, { location: "/page" }).end();
			} else if (req.url === "/page") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(
					"<html><head><title>T</title></head><body><h1>Real page</h1><p>read <b>over the wire</b></p></body></html>",
				);
			} else if (req.url === "/blocked") {
				res.writeHead(403, { "cf-mitigated": "challenge" }).end();
			} else {
				res.writeHead(404, { "content-type": "text/plain" }).end("nope");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as { port: number }).port;
	});

	afterAll(() => {
		server.close();
	});

	it("reads a page and turns the HTML into markdown", async () => {
		const result = await fetchUrlLocal(`http://127.0.0.1:${port}/page`, { allowPrivate: true });
		expect(result.content).toBe("# Real page\n\nread **over the wire**");
		expect(result.warnings).toEqual([]);
	});

	it("follows a redirect by hand, one validated hop at a time", async () => {
		hits.length = 0;
		const result = await fetchUrlLocal(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true, format: "text" });
		expect(result.content).toBe("Real pageread over the wire");
		expect(hits.map((h) => h.split(" ")[1])).toEqual(["/redirect", "/page"]);
	});

	it("reports an HTTP error status, and retries a Cloudflare challenge with a plain user agent", async () => {
		await expect(fetchUrlLocal(`http://127.0.0.1:${port}/missing`, { allowPrivate: true })).rejects.toThrow(
			/HTTP 404/,
		);
		hits.length = 0;
		await expect(fetchUrlLocal(`http://127.0.0.1:${port}/blocked`, { allowPrivate: true })).rejects.toThrow(
			/HTTP 403/,
		);
		expect(hits.map((h) => h.split("ua=")[1])).toEqual(["Mozilla", "cast"]);
	});

	it("refuses every loopback and internal address by default, and the server never sees a request", async () => {
		hits.length = 0;
		for (const host of [
			"127.0.0.1",
			"[::1]",
			"0.0.0.0",
			"10.1.2.3",
			"169.254.169.254",
			"192.168.0.1",
			"172.16.0.9",
		]) {
			await expect(fetchUrlLocal(`http://${host}:${port}/page`)).rejects.toThrow(/Refusing/);
		}
		expect(hits).toEqual([]);
	});

	it("refuses an IPv4 address written inside an IPv6 one, however it is spelled", async () => {
		// `new URL` rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1]; the check used to look only for the dotted form.
		hits.length = 0;
		for (const host of [
			"[::ffff:127.0.0.1]",
			"[::ffff:7f00:1]",
			"[0:0:0:0:0:ffff:7f00:1]",
			"[::127.0.0.1]",
			"[::7f00:1]",
			"[64:ff9b::7f00:1]",
			"[64:ff9b::a00:1]",
			"[64:ff9b:1::1]",
			"[2002:7f00:1::]",
			"[2002:a9fe:a9fe::1]",
			"[2001::1]",
			"[fe80::1]",
			"[fec0::1]",
			"[fd00::1]",
			"[ff02::1]",
			"[100::1]",
			"[2001:db8::1]",
		]) {
			await expect(fetchUrlLocal(`http://${host}:${port}/page`), host).rejects.toThrow(/Refusing/);
		}
		expect(hits).toEqual([]);
	});

	it("lets a public IPv6 address through the check (the request itself is not made: the signal is already aborted)", async () => {
		const aborted = AbortSignal.abort();
		for (const host of [
			"[2606:4700:4700::1111]",
			"[2a00:1450:4001::68]",
			"[::ffff:8.8.8.8]",
			"[64:ff9b::808:808]",
			"[2002:808:808::1]",
		]) {
			await expect(fetchUrlLocal(`http://${host}/`, { signal: aborted }), host).rejects.not.toThrow(/Refusing/);
		}
	});

	it("refuses the documentation and relay ranges as well", async () => {
		for (const host of ["192.0.2.1", "198.51.100.7", "203.0.113.9", "192.88.99.1", "100.64.0.1", "255.255.255.255"]) {
			await expect(fetchUrlLocal(`http://${host}/`), host).rejects.toThrow(/Refusing/);
		}
	});
});
