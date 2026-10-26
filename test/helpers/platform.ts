export async function withPlatform<T>(platform: NodeJS.Platform, action: () => T | Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor?.configurable) throw new Error("process.platform cannot be overridden in this runtime");
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try {
		return await action();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}
