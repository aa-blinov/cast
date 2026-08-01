import { describe, expect, it } from "vitest";

import { isBlockedAttachmentName, partitionFiles } from "../src/web/public/composer-attachments.js";

describe("web composer attachments", () => {
	it("blocks executable attachment names", () => {
		expect(isBlockedAttachmentName("install.EXE")).toBe(true);
		expect(isBlockedAttachmentName("notes.txt")).toBe(false);
	});

	it("partitions image and document files", () => {
		const image = { type: "image/png" } as File;
		const document = { type: "text/plain" } as File;
		expect(partitionFiles([image, document])).toEqual({ images: [image], docs: [document] });
	});
});
