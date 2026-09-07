import { readFileSync } from "node:fs";
import { join } from "node:path";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode.js";
import { describe, expect, it } from "vitest";
import { imageDimensionsFromHeader, MAX_IMAGE_PIXELS, resizeImageForEmbedding } from "../src/core/image-resize.ts";

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
		// 1800×1350 (not 2400×1800): still well above the 1568 downscale cap
		// and the 300KB skip threshold, but mozjpeg-encoding noise is the
		// single most expensive thing in the suite (~12s at 2400×1800) — this
		// keeps a meaningful downscale at roughly half the encode cost.
		const large = await makeLargeJpeg(1800, 1350);
		expect(large.byteLength).toBeGreaterThan(300 * 1024); // must actually cross the skip threshold to be a real test

		const result = await resizeImageForEmbedding(large, "image/jpeg");
		expect(result).toBeDefined();
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.buffer.byteLength).toBeLessThan(large.byteLength);

		const decoded = await decodeJpeg(
			result!.buffer.buffer.slice(result!.buffer.byteOffset, result!.buffer.byteOffset + result!.buffer.byteLength),
		);
		expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1568);
		// Aspect ratio preserved (1800:1350 = 4:3).
		expect(decoded.width / decoded.height).toBeCloseTo(1800 / 1350, 1);
	}, 90_000);

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
	}, 45_000);
});

describe("imageDimensionsFromHeader / MAX_IMAGE_PIXELS", () => {
	// A byte cap says nothing about what a file expands to: a 652KB
	// 15000×15000 PNG decodes to 858MB of RGBA, and reading one took the
	// process from 110MB to 3.3GB of RSS in 6.6s — inside the daemon, where
	// every session shares that memory.
	function png(width: number, height: number): Buffer {
		const header = Buffer.alloc(24);
		header.writeUInt32BE(0x89504e47, 0);
		header.writeUInt32BE(width, 16);
		header.writeUInt32BE(height, 20);
		return header;
	}

	function jpeg(width: number, height: number): Buffer {
		// SOI, then a minimal SOF0 segment carrying the size.
		const buf = Buffer.alloc(20, 0);
		buf[0] = 0xff;
		buf[1] = 0xd8;
		buf[2] = 0xff;
		buf[3] = 0xc0;
		buf.writeUInt16BE(11, 4); // segment length
		buf.writeUInt16BE(height, 7);
		buf.writeUInt16BE(width, 9);
		return buf;
	}

	it("reads PNG dimensions without decoding pixels", () => {
		expect(imageDimensionsFromHeader(png(15000, 15000))).toEqual({ width: 15000, height: 15000 });
	});

	it("reads JPEG dimensions from the frame header", () => {
		expect(imageDimensionsFromHeader(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 });
	});

	it("returns undefined for anything it does not recognise", () => {
		expect(imageDimensionsFromHeader(Buffer.from("not an image at all"))).toBeUndefined();
	});

	it("puts a bomb over the pixel ceiling and an ordinary photo under it", () => {
		const bomb = 15000 * 15000;
		const photo = 4000 * 3000;
		expect(bomb).toBeGreaterThan(MAX_IMAGE_PIXELS);
		expect(photo).toBeLessThan(MAX_IMAGE_PIXELS);
	});
});
