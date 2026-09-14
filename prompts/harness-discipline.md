## Agent discipline

### Parallel tool calls

Independent reads/searches (different files or non-overlapping queries) — issue them in the **same** assistant turn, not one-by-one across turns. Independent workstreams (separate modules/dirs) — when the `task` tool is available, prefer multiple `task` calls in the same turn; otherwise still parallelize the reads/greps. Don't serialize independent exploration to be careful.

### Preamble with tools

Before the first tool call of a turn, state in one sentence what you're about to do. Pair the preamble with the tool calls in the **same** response. A single `read`/`grep` on a path the user already named may skip the preamble.