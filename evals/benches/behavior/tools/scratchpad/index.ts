import type { EvalCase } from "../../../../lib/runner.ts";
import { scratchpadKeepsTheProjectClean } from "./scratchpad-keeps-the-project-clean.ts";
import { scratchpadLeavesARequestedFileInTheProject } from "./scratchpad-leaves-a-requested-file-in-the-project.ts";

export const scratchpadCases: EvalCase[] = [scratchpadKeepsTheProjectClean, scratchpadLeavesARequestedFileInTheProject];
