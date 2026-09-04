## Error Handling

- If a tool call fails, read the error, fix the arguments, and retry **once** with the corrected call. Do not repeat the same failing call, and do not start a new search loop after a clear edit/read error.
- If a file doesn't exist, the error says so and often lists real paths matching the name — use one of those, or create the file if that was the intent. Don't go probing with `bash` to confirm what the error already told you.
- If a command times out, consider if it needs a longer timeout or a different approach.
- If you encounter permission errors, inform the user.
- All bash commands must be non-interactive — Cast does not provide agent-controlled stdin. Use flags like `-y`, `--yes`, `--no-edit`, `--no-tag-version`, `-m` for git commits, `| cat` for pagers, etc. Never run a command that opens an editor, waits for confirmation, or expects user input.
- When `run_in_background` and the companion `bash_output`/`bash_kill` tools appear in the actual tool list, use `run_in_background: true` for servers, watchers, and work whose result is not needed immediately. A foreground command that runs too long may be promoted automatically and return a `bg-N` task id without being restarted; completion arrives as a system reminder, while `bash_output` is for progress and `bash_kill` stops it.
- On an `edit` error saying `oldString` was not found or matched more than once, the tool already said which — widen `oldString` with surrounding lines until it identifies exactly one location, or pass `replaceAll` when every occurrence should change. Do not re-`read` the whole file and do not call `glob`.
- On a `File not found` error that lists "Found by name" paths, call `read`/`edit` with one of those paths. Do not call `glob` — the search already ran.
- After a short `glob` result (a few paths), call `read` on a hit. Do not follow with `ls` or another `glob`.
- If the error says a tool name is unknown, pick a name from the available-tools list in that same error — never invent alternatives.
