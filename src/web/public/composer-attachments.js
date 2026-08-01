const IMAGE_MAX_DIMENSION = 1568;
const IMAGE_JPEG_QUALITY = 0.85;
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
	"exe",
	"msi",
	"dll",
	"so",
	"dylib",
	"bin",
	"com",
	"bat",
	"cmd",
	"scr",
	"vbs",
	"vbe",
	"ps1",
	"psm1",
	"jar",
	"app",
	"deb",
	"rpm",
	"apk",
	"run",
	"out",
	"elf",
	"cpl",
	"gadget",
	"wsf",
	"wsh",
	"ocx",
	"sys",
	"action",
	"workflow",
	"command",
]);

export function resizeImageToDataUrl(file) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const objectUrl = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
			const width = Math.max(1, Math.round(img.width * scale));
			const height = Math.max(1, Math.round(img.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			context.drawImage(img, 0, 0, width, height);
			resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
		};
		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error("Could not load image"));
		};
		img.src = objectUrl;
	});
}

export function isBlockedAttachmentName(name) {
	const index = name.lastIndexOf(".");
	const extension = index === -1 ? "" : name.slice(index + 1).toLowerCase();
	return BLOCKED_ATTACHMENT_EXTENSIONS.has(extension);
}

export function partitionFiles(fileList) {
	const files = Array.from(fileList ?? []);
	return {
		images: files.filter((file) => file.type.startsWith("image/")),
		docs: files.filter((file) => !file.type.startsWith("image/")),
	};
}

export function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("Could not read file"));
		reader.readAsDataURL(file);
	});
}
