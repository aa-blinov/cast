## File tools / hashline anchors

### Workflow (every persona)

1. **User named a file** (`config`, `greet.ts`, `CHANGELOG.md`, `README`, …) → call `read` on that name **first**. Do **not** call `glob` or `ls` beforehand. If `read` fails with "Found by name", use one of those paths immediately.
2. **Path fully unknown** → one `glob` or `grep`, then `read` the hit. Stop searching once you have the file — no second/third `glob`, no `ls` "to confirm".
3. **Edit** with anchors from that `read`/`grep`. Put **all** ops for one file in a **single** `edit` call.
4. On success, the tool returns fresh anchors — use those for a follow-up edit. Do **not** re-`read` the same file just to confirm unless the snippet looks wrong.
5. Use only tool names from the available list. Never invent tools (e.g. there is no `search_files` — use `glob` or `grep`).

### Anchors

Each line `read` and `grep` returns is prefixed with `<LINE>:<LOCAL>:<CHUNK>→content`
(e.g. `22:abc:rst`). To `edit` a line, copy the full three-part prefix
`<LINE>:<LOCAL>:<CHUNK>` into `anchor` — include the line number. Do not
re-type the line text.

You may paste the whole gutter (`22:abc:rst→…`); the tool strips the arrow
and content. If you accidentally omit the line number (`abc:rst`), the tool
recovers it when that hash pair is unique in the file — still prefer the
full three-part form.

Anchors are validated against the current file. If the anchored content
merely moved (lines inserted above) or a neighbour changed while the line
itself is intact, the edit is applied automatically and the reply carries a
`Note:` saying where; you only get an error when the anchor is genuinely
ambiguous or its content is gone — that error includes fresh anchors and a
snippet, so a re-`read` is usually unnecessary.

### Ops

- `replace` — change one line or a range. Range uses `anchor` and
  `end_anchor` (both INCLUSIVE). Without `end_anchor` exactly ONE line is
  replaced, no matter how many lines `content` has — to rewrite a region,
  always pass `end_anchor`. To delete lines, set `content` to "". When a
  deletion would leave two blank lines touching, widen the range to take
  one of the blanks with it.
- `insert_after` — add new lines after the anchor. Use `content` with
  newlines to insert multiple lines; use `"0:"` to insert at the top of
  the file; use `"EOF"` to append at the end (e.g. a new README section).
- `insert_before` — add new lines above the anchored line. Prefer this
  over insert_after with an N-1 anchor when the natural reference point
  is the line the text goes above (e.g. a heading). Mind blank separator
  lines — include them in `content`. Not valid with `"EOF"`.
- `write` — replace the whole file (no anchors needed). Prefer `write`
  only for new files or full rewrites; use `edit` for surgical changes.
- Put ALL edits to one file in a single call's `ops[]` — they are
  validated against the same snapshot and applied atomically, so anchors
  from one `read` stay consistent. If any op is rejected, nothing is
  written.
- Two `replace` ops whose ranges overlap are rejected — merge them into one
  op with a wider range. An insert anchored strictly inside a
  `replace` range is also rejected — fold the text into the replace content.
- A successful edit replies with the edited regions and their fresh
  anchors — check that snippet before issuing the next op instead of
  assuming the file looks the way you intended.
- On a `stale-anchor` or malformed-anchor error, use the fresh anchors the
  tool returned — don't re-`read` and don't invent a new anchor format.
