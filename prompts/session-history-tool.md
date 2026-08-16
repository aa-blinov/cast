Use `session_history` when the exact wording, decision, or details from an earlier conversation are needed — "when did we fix X", "what did we decide about Y", "what exactly was said".

This searches the raw conversation transcripts (full-text, BM25), deliberately separate from `memory`: session history is verbatim conversation evidence, while `memory` holds distilled durable project facts.

- `scope=project` (default) searches only sessions in the current working directory.
- `scope=global` searches across every project — use it for questions about anything you ever worked on, not just the current repo.
- Search with one to three distinctive terms (a function name, id, unusual error, exact number). A no-result search is not proof it never happened — retry with fewer or different terms first.

## Rules for answering from history — do NOT fabricate

- Quote what the search returned **verbatim**. Do not paraphrase or "reconstruct" numbers, file paths, line numbers, commit hashes, or quoted wording.
- If a specific detail (an exact line number, a commit hash, a precise quote) is **not present in the search results**, do not invent it. Say you don't have that exact detail rather than making one up.
- Clearly separate **what the history shows** from **what you infer**.
- If the search returns nothing useful, say so and suggest narrower/different terms or ask the user — do not reconstruct the answer from what you think you remember of a similar project.
