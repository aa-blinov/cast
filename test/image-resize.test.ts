import { readFileSync } from "node:fs";
import { join } from "node:path";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode.js";
import { describe, expect, it } from "vitest";
import { resizeImageForEmbedding } from "../src/core/image-resize.ts";

// Real codecs, real WASM init, real images — this is the same pipeline
// execRead uses (tools/files.ts), not a mock. Builds its own oversized test
// images instead of depending on a fixture file so it's reproducible
// anywhere (no external file needed, no fragile golden file to keep in sync).
const wasmDir = join(import.meta.dirname, "..", "wasm");

async function makeLargeJpeg(width: number, height: number): Promise<Buffer> {
	await initJpegDecode(await WebAssembly.compile(readFileSync(join(wasmDir, "mozjpeg_dec.wasm"))));
	await initJpegEncode(await WebAssembly.compile(readFileSync(join(wasmDir, "mozjpeg_enc.wasm"))));
	// Noise, not a solid color — a flat image compresses to almost nothing
	// under JPEG and would never cross SKIP_RESIZE_BELOW_BYTES no matter the
	// resolution, defeating the point of this fixture.
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = Math.floor(Math.random() * 256);
		data[i + 1] = Math.floor(Math.random() * 256);
		data[i + 2] = Math.floor(Math.random() * 256);
		data[i + 3] = 255;
	}
	const imageData = { width, height, data, colorSpace: "srgb" as PredefinedColorSpace };
	const encoded = await encodeJpeg(imageData, { quality: 90 });
	return Buffer.from(encoded);
}

async function makeSmallPng(width: number, height: number): Promise<Buffer> {
	const png = readFileSync(join(wasmDir, "squoosh_png_bg.wasm"));
	await initPngEncode(png);
	const data = new Uint8ClampedArray(width * height * 4).fill(120);
	const imageData = { width, height, data, colorSpace: "srgb" as PredefinedColorSpace };
	const encoded = await encodePng(imageData);
	return Buffer.from(encoded);
}

describe("resizeImageForEmbedding", () => {
	it("downscales a large, noisy jpeg to fit within the max dimension", async () => {
		const large = await makeLargeJpeg(2400, 1800);
		expect(large.byteLength).toBeGreaterThan(300 * 1024); // must actually cross the skip threshold to be a real test

		const result = await resizeImageForEmbedding(large, "image/jpeg");
		expect(result).toBeDefined();
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.buffer.byteLength).toBeLessThan(large.byteLength);

		const decoded = await decodeJpeg(
			result!.buffer.buffer.slice(result!.buffer.byteOffset, result!.buffer.byteOffset + result!.buffer.byteLength),
		);
		expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1568);
		// Aspect ratio preserved (2400:1800 = 4:3).
		expect(decoded.width / decoded.height).toBeCloseTo(2400 / 1800, 1);
	}, 20_000);

	it("leaves a small image alone (returns undefined — caller keeps the original)", async () => {
		const small = await makeSmallPng(200, 150);
		expect(small.byteLength).toBeLessThan(300 * 1024);
		const result = await resizeImageForEmbedding(small, "image/png");
		expect(result).toBeUndefined();
	}, 20_000);

	it("returns undefined for an unsupported format (gif/webp/bmp — no codec vendored)", async () => {
		const result = await resizeImageForEmbedding(Buffer.alloc(400 * 1024, 1), "image/gif");
		expect(result).toBeUndefined();
	});

	it("never throws on garbage bytes — returns undefined instead of crashing the read", async () => {
		const garbage = Buffer.alloc(400 * 1024, 0xff);
		await expect(resizeImageForEmbedding(garbage, "image/jpeg")).resolves.toBeUndefined();
	}, 20_000);
});
