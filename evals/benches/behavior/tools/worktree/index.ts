import type { EvalCase } from "../../../../lib/runner.ts";
import { worktreeEntersAndWorksThere } from "./worktree-enters-and-works-there.ts";
import { worktreeFromPlainWording } from "./worktree-from-plain-wording.ts";
import { worktreeGoesBack } from "./worktree-goes-back.ts";
import { worktreeNotOnItsOwn } from "./worktree-not-on-its-own.ts";

export const worktreeCases: EvalCase[] = [
	worktreeEntersAndWorksThere,
	worktreeFromPlainWording,
	worktreeNotOnItsOwn,
	worktreeGoesBack,
];
