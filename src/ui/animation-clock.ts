import { loadSettings } from "../core/settings.ts";

/** Read when a spinner or the status bar starts ticking, so a settings edit applies on the next turn. */
export function reduceMotion(): boolean {
	const env = process.env.CAST_REDUCE_MOTION;
	if (env !== undefined && env !== "") return env !== "0";
	return loadSettings().reduceMotion === true;
}
