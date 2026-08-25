---
name: forge-review
description: Review and reply to merge/pull requests on GitLab (glab), GitHub (gh), Gitea/Forgejo (tea) — fetch threaded discussions, reply in-thread, resolve. Use when user asks to check MR/PR feedback, reply to reviewers, handle code review, or resolve discussions on any forge.
---

# Forge review — unified MR/PR workflow

One workflow, three CLIs. Detect forge from `git remote`, then use the matching section. Never invent standalone notes — always reply inside the thread.

## Detect forge

```bash
git remote get-url origin
# git@github.com:org/repo.git  → GitHub (gh)
# git@gitlab.com:org/repo.git  → GitLab (glab)
# git@gitea.example.com:org/repo.git → Gitea/Forgejo (tea)
which gh glab tea 2>&1 | head
```

## GitLab (glab) — threaded discussions

**List discussions (what reviewers see):**
```bash
# encode path: org/repo → org%2Frepo
glab api "projects/<encoded_path>/merge_requests/<iid>/discussions"
```
Filter unresolved:
```python
for d in discussions:
    for n in d.get("notes", []):
        if n.get("resolvable") and not n.get("resolved"):
            print(f'id={d["id"]} author={n["author"]["username"]} {n["body"][:120]}')
```

**Reply inside thread (CORRECT):**
```bash
glab api "projects/<path>/merge_requests/<iid>/discussions/<discussion_id>/notes" --method POST -f body="reply"
```
**Wrong:** `glab mr note <iid> -m "..."` — creates standalone note.

**Resolve:**
```bash
glab api "projects/<path>/merge_requests/<iid>/discussions/<discussion_id>" --method PUT -f resolved=true
```

## GitHub (gh) — review threads

**List threads:**
```bash
gh pr view <pr> --json comments,reviews --jq '.comments[]'
# or threaded review comments
gh api repos/<owner>/<repo>/pulls/<pr>/comments --paginate | jq '.[] | {id, path, body, in_reply_to_id}'
```

**Reply in thread:**
```bash
# reply to a review comment (preserves thread)
gh api repos/<owner>/<repo>/pulls/<pr>/comments -f body="reply" -f in_reply_to=<comment_id>
# or simple PR comment
gh pr comment <pr> --body "reply"
```

**Resolve (GitHub review threads are not resolvable via CLI — mark via UI or):**
```bash
gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"<thread_id>"}) { thread { isResolved } } }'
# fallback: reply "Resolved in <commit>" and request re-review
gh pr ready <pr>
```

## Gitea / Forgejo (tea)

```bash
tea pr list --repo org/repo
tea pr comment --repo org/repo --index <pr> "reply"
# threaded if server supports review comments:
tea api GET /repos/<owner>/<repo>/pulls/<pr>/reviews
```

## Typical workflow (forge-agnostic, 8 steps)

1. Detect forge, fetch unresolved threads (GitLab discussions / GitHub review comments)
2. Implement fix on MR/PR branch
3. Run tests (`npm test`, `pytest`, `docker compose exec ...`)
4. Run linter (`ruff check`, `biome check`, `npm run check`)
5. Commit with clear message, `git push origin <branch>`
6. Reply **inside the thread** with what was done + commit link
7. Resolve thread (GitLab PUT resolved=true / GitHub graphql / Gitea via UI)
8. Delete accidental standalone notes: `glab api .../notes/<id> --method DELETE` / `gh api .../comments/<id> -X DELETE`

## Anti-patterns

- **Standalone note instead of threaded reply** — reviewer never sees it in context.
- **Resolving without reply** — leaves reviewer guessing.
- **Pushing without verify** — run `verification-before-completion` gate before reply.
