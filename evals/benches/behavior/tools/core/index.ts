import type { EvalCase } from "../../../../lib/runner.ts";
import { requiredReadTool } from "./required-read-tool.ts";
import { directRequestStaysBuild } from "./direct-request-stays-build.ts";
import { readRangeUsesOffsetLimit } from "./read-range-uses-offset-limit.ts";
import { grepArgumentIsGrounded } from "./grep-argument-is-grounded.ts";
import { globArgumentIsGrounded } from "./glob-argument-is-grounded.ts";
import { writeCreatesParentDirectories } from "./write-creates-parent-directories.ts";
import { knownPathSkipsSearch } from "./known-path-skips-search.ts";
import { lsDirectoryArgument } from "./ls-directory-argument.ts";
import { todoWriteStructuredList } from "./todo-write-structured-list.ts";
import { bashArgumentGrounding } from "./bash-argument-grounding.ts";
import { grepFlagsAreGrounded } from "./grep-flags-are-grounded.ts";
import { writeOverwritesExistingFile } from "./write-overwrites-existing-file.ts";

export const coreCases: EvalCase[] = [
	requiredReadTool,
	directRequestStaysBuild,
	readRangeUsesOffsetLimit,
	grepArgumentIsGrounded,
	globArgumentIsGrounded,
	writeCreatesParentDirectories,
	knownPathSkipsSearch,
	lsDirectoryArgument,
	todoWriteStructuredList,
	bashArgumentGrounding,
	grepFlagsAreGrounded,
	writeOverwritesExistingFile,
];
