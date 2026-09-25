/**
 * Voice notes for models that take audio input. Browsers record webm/opus
 * (Safari mp4), while OpenAI-compatible `input_audio` takes WAV or MP3 only,
 * so the recording is decoded and re-encoded as 16 kHz mono PCM WAV: speech
 * loses nothing at that rate and it costs 32 KB a second.
 */

const SAMPLE_RATE = 16_000;
export const MAX_VOICE_SECONDS = 300;

/** Why recording can't start here, or null when it can. */
export function voiceUnavailableReason() {
	if (typeof window === "undefined") return "Not supported here";
	if (!window.isSecureContext) return "Voice needs HTTPS or localhost";
	if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
		return "This browser can't record audio";
	}
	return null;
}

/** 16-bit PCM WAV bytes for mono float samples in [-1, 1]. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const ascii = (offset, text) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return new Uint8Array(buffer);
}

function bytesToBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

async function toWavDataUrl(blob) {
	const AudioCtx = window.AudioContext || window.webkitAudioContext;
	const ctx = new AudioCtx();
	try {
		const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
		const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start();
		const rendered = await offline.startRendering();
		return {
			dataUrl: `data:audio/wav;base64,${bytesToBase64(encodeWav(rendered.getChannelData(0)))}`,
			seconds: decoded.duration,
		};
	} finally {
		void ctx.close();
	}
}

/**
 * Starts recording from the microphone. `stop()` resolves to
 * `{ dataUrl, seconds }`; `cancel()` discards it. `onLimit` fires when the
 * recording hits MAX_VOICE_SECONDS and stops on its own.
 */
export async function startVoiceRecording({ onLimit } = {}) {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	const recorder = new MediaRecorder(stream);
	const chunks = [];
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	const stopped = new Promise((resolve) => {
		recorder.onstop = () => {
			for (const track of stream.getTracks()) track.stop();
			resolve(new Blob(chunks, { type: recorder.mimeType }));
		};
	});
	recorder.start();
	const limit = setTimeout(() => {
		if (recorder.state === "recording") {
			recorder.stop();
			onLimit?.();
		}
	}, MAX_VOICE_SECONDS * 1000);
	const finish = () => {
		clearTimeout(limit);
		if (recorder.state === "recording") recorder.stop();
		return stopped;
	};
	return {
		stop: async () => toWavDataUrl(await finish()),
		cancel: () => void finish(),
	};
}
