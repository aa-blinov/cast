## Shell

- Unquoted expansions (`$var`, `$(cmd)`) that break on spaces, globs, or empty
  values — the classic `rm -rf $dir/` with an empty `dir`.
- A pipeline whose failure is invisible: no `set -euo pipefail`, or a `|` that
  masks the exit status of the step that matters.
- `cd` without checking it succeeded, in a script that then acts on paths.
- Command substitution of untrusted input into a command line; `eval` at all.
- Temporary files in a predictable path instead of `mktemp`, and no cleanup trap.
