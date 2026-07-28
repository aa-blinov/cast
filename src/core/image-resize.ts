/**
 * Downscales an image before it's embedded in a tool result — the `read`
 * tool itself doesn't reject on file size, this layer decides whether/how
 * to shrink what it read. Uses WASM codecs (no native binary — confirmed
 * sharp doesn't fit cast's single-esbuild-file distribution model) from the
 * Squoosh project.
 *
 * The .wasm binaries are vendored under wasm/ (same "sibling of dist/" or
 * "sibling of src/" two-candidate resolution as prompts/ — see prompts.ts)
 * rather than read from node_modules at runtime, so a bundled dist/index.js
 * doesn't need node_modules present at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import encodePng, { init as initPngEncode } from "@jsquash/png/encode.js";
import resizeImageData, { initResize } from "@jsquash/resize/index.js";

const _selfDir = dirname(fileURLToPath(import.meta.url));
const wasmDir = existsSync(join(_selfDir, "..", "wasm"))
	? join(_selfDir, "..", "wasm")
	: join(_selfDir, "..", "..", "wasm");

/** Longest side after resize. MiniMax's own docs recommend ~1024px for
 * vision inputs to avoid burning context on pixels a model doesn't need at
 * higher resolution; matches the client-side (web composer attach) cap. */
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 80;
// Below this, resizing isn't worth the re-encode's own CPU cost or any
// quality loss — the image was already small.
const SKIP_RESIZE_BELOW_BYTES = 300 * 1024;

let wasmReady: Promise<void> | undefined;

/** All four codecs' WASM modules only need instantiating once per process —
 * cached behind one promise so concurrent reads don't each redo it. */
function ensureWasmReady(): Promise<void> {
	if (!wasmReady) {
		wasmReady = (async () => {
			const [jpegDec, jpegEnc, png, resize] = await Promise.all([
				readFileSync(join(wasmDir, "mozjpeg_dec.wasm")),
				readFileSync(join(wasmDir, "mozjpeg_enc.wasm")),
				readFileSync(join(wasmDir, "squoosh_png_bg.wasm")),
				readFileSync(join(wasmDir, "squoosh_resize_bg.wasm")),
			]);
			await Promise.all([
				initJpegDecode(await WebAssembly.compile(jpegDec)),
				initJpegEncode(await WebAssembly.compile(jpegEnc)),
				initPngDecode(png),
				initPngEncode(png),
				initResize(resize),
			]);
		})();
	}
	return wasmReady;
}

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export interface ResizedImage {
	buffer: Buffer;
	mimeType: string;
}

/**
 * Resizes `buffer` (already known to be `mimeType`) down to MAX_DIMENSION on
 * its longest side. Returns undefined when the format isn't one of the two
 * codecs vendored here (gif/webp/bmp — the caller's existing size cap is the
 * only protection for those) or when decode/resize/encode itself throws
 * (corrupt file, decoder bug) — callers fall back to the original buffer
 * rather than fail the whole `read`: fail the *resize*, not the read.
 */
export async function resizeImageForEmbedding(buffer: Buffer, mimeType: string): Promise<ResizedImage | undefined> {
	if (!SUPPORTED_MIME_TYPES.has(mimeType)) return undefined;
	if (buffer.byteLength <= SKIP_RESIZE_BELOW_BYTES) return undefined;

	try {
		await ensureWasmReady();
		// Buffer.buffer can be a larger pooled ArrayBuffer than this Buffer's
		// own view — slice to the exact byte range the codecs expect.
		const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
		const imageData =
			mimeType === "image/jpeg" ? await decodeJpeg(arrayBuffer) : await decodePng(arrayBuffer, { bitDepth: 8 });

		const scale = Math.min(1, MAX_DIMENSION / Math.max(imageData.width, imageData.height));
		if (scale >= 1) return undefined; // already within bounds

		const width = Math.max(1, Math.round(imageData.width * scale));
		const height = Math.max(1, Math.round(imageData.height * scale));
		const resized = await resizeImageData(imageData, { width, height });

		if (mimeType === "image/jpeg") {
			const encoded = await encodeJpeg(resized, { quality: JPEG_QUALITY });
			return { buffer: Buffer.from(encoded), mimeType };
		}
		const encoded = await encodePng(resized);
		return { buffer: Buffer.from(encoded), mimeType };
	} catch {
		return undefined;
	}
}
