import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";

const IMAGE_PATH = join(import.meta.dirname, "../../../../fixtures/red-apple.jpg");

export const readImageVision: EvalCase = {
	id: "read-image-vision",
	description: "Reading an image path surfaces its actual visual content, not just a file-exists acknowledgment.",
	signals: ["required-tool", "tool-result-integrity"],
	// Only meaningful with a vision-capable model — `read` shows the image to
	// the model as an image in the next message (see tools.ts's read description);
	// a text-only model can't pass this regardless of tool-call correctness.
	prompt: `Look at the image at ${IMAGE_PATH} and tell me what's in it.`,
	expect: {
		toolsCalled: ["read"],
		containsAny: ["apple", "Apple"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "read" && call.args.path === IMAGE_PATH)
				? undefined
				: "the image was not read via the read tool",
	},
};
