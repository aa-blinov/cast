import { createServer } from "node:net";
import { loadSettings, updateSettings } from "../core/settings.ts";

export interface ServerBind {
	host: string;
	port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The address the person chose with `cast server start --public` (or --host / --port), if any. A daemon
 * started for them later, by the terminal screen or after an upgrade, binds the same address instead of
 * quietly going back to a private random port.
 */
export function rememberedBind(): ServerBind | undefined {
	const bind = loadSettings().serverBind;
	return bind && typeof bind.host === "string" && Number.isInteger(bind.port) ? bind : undefined;
}

/** Keeps an explicit choice; the private random-port default is the same as having chosen nothing. */
export function rememberBind(bind: ServerBind): void {
	const isDefault = LOOPBACK_HOSTS.has(bind.host) && bind.port === 0;
	updateSettings({ serverBind: isDefault ? undefined : bind });
}

/** Whether `bind` can be listened on right now, so a remembered port taken by something else does not stop the start. */
export function canBind(bind: ServerBind): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(bind.port, bind.host, () => probe.close(() => resolve(true)));
	});
}
