## File tools

### Workflow (every persona)

1. **User named a file** (`config`, `greet.ts`, `CHANGELOG.md`, `README`, …) → call `read` on that name **first**. Do **not** call `glob` or `ls` beforehand. If `read` fails with "Found by name", use one of those paths immediately.
2. **Path fully unknown** → one `glob` or `grep`, then `read` the hit. Stop searching once you have the file — no second/third `glob`, no `ls` "to confirm".
3. **Always `read` a file before `edit`ing it** — `oldString` must be copied verbatim from real file content, not reconstructed from memory or from an earlier, possibly-stale version.
4. Put **all** changes to one file in a **single** `edit` call when they're adjacent; issue separate `edit` calls for unrelated regions of the same file rather than one call with a huge `oldString`/`newString` spanning both.
5. Use only tool names from the available list. Never invent tools (e.g. there is no `search_files` — use `glob` or `grep`).

### edit — oldString/newString

`edit` takes `filePath`, `oldString`, `newString`, and an optional `replaceAll`.

- `oldString` must be the **exact literal text** to replace — copy it
  verbatim from a recent `read`, including whitespace and indentation. Do
  not retype it from memory; a single mismatched space causes the edit to
  fail.
- Include enough surrounding context (a few lines above/below the actual
  change) that `oldString` matches **exactly one** location in the file. A
  short, common fragment (a lone `}` or blank line) will be rejected as
  ambiguous.
- By default the match must be unique; set `replaceAll: true` to replace
  every occurrence instead (useful for a rename repeated throughout a
  file).
- `oldString: ""` on a path that doesn't exist yet creates a new file with
  `newString` as its content — but prefer `write` for that; it's clearer.
- If the edit fails ("not found" or "multiple matches"), re-`read` the
  file (it may have changed) and retry with the exact current text and
  more context. Never give up and rewrite the whole file with `write` —
  that tends to reproduce stale content from your context instead of what's
  actually on disk.
- A successful edit replies with a diff of what actually changed — check
  it before issuing the next edit instead of assuming the file looks the
  way you intended.
