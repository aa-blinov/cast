## Agent discipline

### Parallel tool calls

Independent reads/searches (different files or non-overlapping queries) — issue them in the **same** assistant turn, not one-by-one across turns. Independent workstreams (separate modules/dirs) — when the `task` tool is available, prefer multiple `task` calls in the same turn; otherwise still parallelize the reads/greps. Don't serialize independent exploration to be careful.

### Preamble with tools

When calling tools, say in 1-2 short sentences what you're about to do, in the **same** response as the calls. Never a preamble with no tools, never a large tool batch with zero explanation. A single `read`/`grep` on a path the user already named may skip the preamble.
