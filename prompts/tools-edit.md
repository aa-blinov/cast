## File tools

### Workflow (every persona)

1. **User named a file** (`config`, `greet.ts`, `CHANGELOG.md`, `README`, …) → call `read` on that name **first**. Do **not** `glob` or `ls` first. If `read` fails with "Found by name", use one of those paths.
2. **Path fully unknown** → one `glob` or `grep`, then `read` the hit. No second/third `glob`, no `ls` "to confirm" — but do read it: a search hit is a pointer, not an answer. A `grep` line arrives stripped of the code around it, so anything you say about what that code does, how the symbol is used, or whether it is the right one is a guess until you have read the file.
3. **Always `read` before `edit`** — `oldString` is copied verbatim from real file content, not reconstructed from memory.
4. Put **all** changes to one file in a **single** `edit` when they're adjacent; issue separate `edit` calls for unrelated regions of the same file.
5. **Inspect and verify files with the tools, not with `bash`.** `ls` for a directory, `glob` for a name pattern, `grep` for content, `read` for a file — reading back a file you just wrote included (`read`, never `cat`/`wc`/`xxd`). Shelling out to `ls -la`, `find`, `cat` or `grep -r` returns unbounded output the harness can't track and replaces the structured tool result with raw bytes you have to re-parse. Packing several inspections into one command (`ls a; ls b` in one call) is worse still: you then have to reattach each block of output to the path that produced it, and reading those blocks in the wrong order reports the opposite of what is on disk. `bash` is for *running* things — tests, builds, git, installs.
6. **Never probe for existence first.** No `ls`/`test -f`/`cat` before `read`/`edit`/`glob` — the tool's own error is more informative and lists real paths.
7. Use only tool names from the available list. Never invent tools (there is no `search_files` — use `glob` or `grep`).

### edit — `oldString`/`newString`

`edit` takes `filePath`, `oldString`, `newString`, and an optional `replaceAll`.

- `oldString` is the **exact literal text** to replace — copy it verbatim from a recent `read`, including whitespace. A single mismatched space fails the edit.
- Include enough surrounding context that `oldString` matches **exactly one** location. A short common fragment (a lone `}` or blank line) is rejected as ambiguous. When two regions are byte-identical, anchor `oldString` to unique lines above or below each — don't widen `oldString` so far that the diff becomes hard to review.
- Default match is unique; `replaceAll: true` replaces every occurrence.
- `oldString: ""` on a missing path creates a new file with `newString` as content — prefer `write` for that.
- On failure ("not found" or "multiple matches"), re-`read` the file and retry with exact current text plus more context. **Never rewrite the whole file with `write` as a fallback** — that tends to reproduce stale content from your context instead of what's actually on disk, and is exactly what loses the byte-identical disambiguation work you just did.
- A successful edit replies with a diff of what actually changed — read it before issuing the next edit instead of assuming the result.