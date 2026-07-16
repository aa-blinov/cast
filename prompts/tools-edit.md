## edit / hashline anchors

Each line `read` and `grep` returns is prefixed with `<LINE>:<LOCAL>:<CHUNK>→content`
(e.g. `22:abc:rst`). To `edit` a line, copy its full `<LINE>:<LOCAL>:<CHUNK>`
prefix into the `anchor` field — don't re-type the line text. Anchors are
validated against the current file; on a mismatch the tool replies with
fresh anchors and a snippet you can use to retry, so a re-`read` is
usually unnecessary. If the anchored content merely moved (lines inserted
above it), the error names the exact shifted anchor to retry with.

- `replace` — change one line or a range. Range uses `anchor` and
  `end_anchor` (both INCLUSIVE). To delete lines, set `content` to "".
- `insert_after` — add new lines after the anchor. Use `content` with
  newlines to insert multiple lines; use "0:" to insert at the top of
  the file.
- `write` — replace the whole file (no anchors needed).
- Multiple ops in one call are validated against the pre-edit file and
  applied atomically; if any anchor is stale, the whole batch is rejected.
- Two `replace` ops whose ranges overlap are rejected — merge them into one
  op with a wider range. An `insert_after` anchored strictly inside a
  `replace` range is also rejected — fold the text into the replace content.
- On a `stale-anchor` error, use the fresh anchors the tool returned
  in the error message — don't re-`read` and don't guess a new anchor.
