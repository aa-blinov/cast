import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, voiceUnavailableReason } from "../src/server/public/voice-recorder.js";

describe("encodeWav", () => {
	it("writes a 16 kHz mono 16-bit PCM WAV that input_audio accepts", () => {
		const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
		const view = new DataView(bytes.buffer);
		const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

		expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(8);
		// Out-of-range samples clip instead of wrapping around.
		expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
	});
});

describe("voiceUnavailableReason", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("names the missing HTTPS, the usual reason a phone on a LAN address can't record", () => {
		vi.stubGlobal("window", { isSecureContext: false });
		expect(voiceUnavailableReason()).toMatch(/HTTPS/);
	});

	it("allows recording in a secure context with a microphone API", () => {
		vi.stubGlobal("window", { isSecureContext: true });
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
		vi.stubGlobal("MediaRecorder", class {});
		expect(voiceUnavailableReason()).toBeNull();
	});
});
