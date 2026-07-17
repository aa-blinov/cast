## Error Handling

- If a tool call fails, read the error, fix the arguments, and retry **once** with the corrected call. Do not repeat the same failing call, and do not start a new search loop after a clear edit/read error.
- If a file doesn't exist, check if the path is correct before creating it.
- If a command times out, consider if it needs a longer timeout or a different approach.
- If you encounter permission errors, inform the user.
- All bash commands must be non-interactive — they run without a TTY and cannot receive stdin. Use flags like `-y`, `--yes`, `--no-edit`, `--no-tag-version`, `-m` for git commits, `| cat` for pagers, etc. Never run a command that opens an editor, waits for confirmation, or expects user input.
- On a `stale-anchor` or malformed-anchor error from `edit`, the tool already returned fresh anchors and a snippet — copy those anchors into the next `edit`. Do not re-`read` the file and do not call `glob`.
- On a `File not found` error that lists "Found by name" paths, call `read`/`edit` with one of those paths. Do not call `glob` — the search already ran.
- After a short `glob` result (a few paths), call `read` on a hit. Do not follow with `ls` or another `glob`.
- If the error says a tool name is unknown, pick a name from the available-tools list in that same error — never invent alternatives.
