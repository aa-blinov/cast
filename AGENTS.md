# AGENTS.md — agent context for `cast`

cast is a terminal coding agent harness: one agent loop, a terminal screen and a browser client on top of it, seven personas that change the agent's judgment, and an extension surface for rules, skills and MCP servers. This file is what you need to work on the project without reading all of it.

## Run / build / test

```bash
npm install --ignore-scripts   # install, and skip the git hooks the prepare script installs
npm run hooks:install          # install the git hooks by hand
npm start                      # run from source through tsx
npm run check                  # tsc --noEmit, then biome check src/ test/
npm test                       # the vitest suite
npm run build                  # bundle into dist/index.js with esbuild
npm run format                 # biome format --write src/ test/
npm run coverage               # vitest with v8 coverage
npm run coverage:check         # the per-file coverage floor CI enforces
npx vitest run test/<file>.test.ts   # one test file
npm run e2e:plan               # a plan-mode smoke test in tmux, against a real provider
```

Node 22 and newer. The order before a commit is `npm run check`, then `npm test`, then `npm run build`. All three have to pass, and `npm run check` is not optional even when the tests are green.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/core/` | The engine, with no UI dependency: the agent loop, the tools, the LLM client, sessions, config, MCP, skills, personas. |
| `src/core/tools/` | The tool executors: bash, files, search, web, task, lsp, ssh, skill, worktree, persona. |
| `src/core/acp/` | The JSON-RPC 2.0 bridge on `@agentclientprotocol/sdk`. It reuses `runAgentLoop` and `AgentRunner` unchanged and translates `AgentEvent` into SDK `sessionUpdate` notifications. See [docs/acp.md](docs/acp.md). |
| `src/ui/` | The behaviour the terminal front end shares with the web server: `app-model.ts`, the slash commands, the themes, the status bar segments, the pickers bridge. |
| `src/ui-pi/` | The default front end, on `@earendil-works/pi-tui`: the alternate screen, app-owned scrolling, the transcript, the editor, the overlays. The app model runs in a headless React root (`headless.ts`). |
| `src/server/` | The optional daemon, the REST and SSE bridge, and the browser client in `public/`. |
| `src/pickers/` | The onboarding pickers for model, persona and reasoning. |
| `prompts/` | The system prompt, the persona files, the compaction templates, the subagent prompts, the built-in skills. Markdown, read at runtime, so a change there needs no build. |
| `test/` | The vitest suite, one `test/<module>.test.ts` per `src/<module>.ts`. |
| `evals/` | The real-model behaviour eval runner and the committed scoreboard data. Not part of the package. |
| `bin/` | The published CLI launcher. |
| `scripts/` | The build, the documentation site and the focused end-to-end scripts. |

The npm package is `cast`, but the source lives directly under `src/`, with no wrapping `cast/` directory. When the user asks about "code", "source" or "сколько кода", they mean `src/`. Do not walk into `evals/`, `test/` or `scripts/` unless they are asked for.

## Traps

- **`npm run check` catches what `npm test` cannot.** Biome format and lint failures, unsorted imports, a multi-line `join()` that biome wants on one line, an unused helper, none of them surface from `npm test`. They fail at the `npm run check` step, and CI's "Type check + lint" step is the same invocation.
- **Gate the commit on the exit code, not on the output.** `npm run check 2>&1 | tail -2` prints a clean-looking tail even when biome failed, and a `git commit && git push` chained after it ships the error. Write `npm run check >/dev/null 2>&1 && git commit ... && git push`, or check `$?`.
- **`npm run coverage:check` reads the last report, not a fresh one.** On its own it passes against a stale report. Run `npm run coverage` first. A green `npm test` with a red CI "Coverage + per-file floor" step means a file dropped below its floor in `coverage-baseline.json`: add tests rather than lowering the baseline.
- **`npm run build` has to run before the tests in CI.** `test/run-interactive-command.test.ts` and `test/worktree-from-worktree.test.ts` spawn the bundled `dist/index.js`. Without a build, `npm ci` leaves `dist/` empty and those two tests fail on the missing module.
- **The bundle resolves `../prompts` and `../package.json` relative to itself.** esbuild rewrites `import.meta.url` for every module it inlines, so the release archive lays `dist/` out as a sibling of `prompts/` and `package.json`. Moving either one breaks the bundle at runtime, in a way no test catches.
- **`node-pty` stays outside the bundle.** It is a native addon, and a JavaScript bundle cannot carry the platform binary. It is marked `external` in `scripts/build.mjs` and has to stay a runtime dependency.
- **The doom-loop detector counts repeats in a window, not in a run.** The threshold is 3 and the window is 12 calls (`DOOM_LOOP_THRESHOLD * 4` in `src/core/loop.ts`), so an alternating pair of identical calls is caught as well. `bash_output` is exempt. The check runs before the parallel dispatch, in call order, because checking inside `Promise.all` hid a whole batch of identical calls from itself.
- **The parallel-safe tool set is a list, and `read` is not on it.** `glob`, `grep`, `lsp`, `ls`, `memory`, `session_history`, `web_search`, `web_fetch` and `bash_output` may run concurrently inside one assistant message. Everything else, `read` included, runs in call order, so a mutation cannot race a sibling. Adding a name to that set changes the concurrency contract for the whole model.
- **`cast run` executes inside the daemon.** Its `--skill` and `--mcp` paths are read there, and the daemon does not receive them, so the run says so on stderr and continues without them. Install into `~/.cast/skills/` or `~/.cast/mcp.json`, or run with `CAST_NO_DAEMON=1`.
- **The `bash` tool's `timeout` is in milliseconds.** The default is 180000 and the maximum is 3600000. A value under 1000 is read as seconds and converted, with a warning. Nothing legitimately asks for a sub-second deadline.
- **The terminal screen has to be checked at 46 columns and at 100.** Use tmux with a scratch `HOME` and never the real `~/.cast`: otherwise the session store, the settings and the scratchpads of the real one get written. Every row must fit the width, and the fit is measured with `visibleWidth`, not `.length`.
- **Separators and markers are ASCII.** ` * `, `*`, `-`, `+`, `[x]`. `ui-pi/ascii.ts` swaps the box and arrow glyphs for ASCII on a terminal that is not UTF-8, and a new glyph that is not in its map breaks that look.
- **Text colours go through `paint()`.** It lifts them to 4.5:1 against the terminal's own background. Raw SGR codes and hard-coded truecolor break the contrast floor.
- **The terminal screen is a thin client of the daemon.** It starts one on loopback when none is alive and talks to it over HTTP and SSE. `CAST_NO_DAEMON=1` is the local fallback, and `cast run` has none: it requires the daemon.
- **`--public` serves plain HTTP.** It cannot protect the password or the session from a network observer. Keep cast on its loopback address and tunnel with `ssh -L 1337:127.0.0.1:1337 user@host`.
- **Project-local resources are trust-gated, global ones are not.** Skills, MCP servers, context files, personas, rules, hooks and `.cast/ssh.json` under the project ask once, and the decision is saved in `settings.json` under `projectTrust`. Everything under `~/.cast/` loads without a check.
- **The web tools are off by default.** When they are off they are not advertised to the model at all, so the model does not know they exist. `/web` turns them on and the choice is persisted.
- **The daemon is the only writer to the session store.** Sessions live in SQLite at `~/.cast/sessions/sessions.db`. Two writers were the reason the loop moved into the daemon in the first place, so a second writer is a regression, not a feature.
- **Persona priority is project, then global, then builtin, and the first one loaded wins.** A global or project persona with a builtin name overrides it. A builtin is never edited in place.

## Style / safety rails

- **Short, direct, technical prose. No emoji, anywhere.** Answer the user's question before making edits or running commands. When the user gives feedback, say whether you agree or disagree before describing the change.
- **Comments explain why, never what.** The comments in this codebase are unusually good on this point. Keep them that way.
- **Read a file in full before making wide-ranging changes to it.**
- **No `any` unless it is truly unavoidable.** Check `node_modules` for the real external API types and signatures rather than guessing them.
- **Inline single-line helpers that have one call site.**
- **No inline imports.** `await import()` and `import("pkg").Type` are out; use top-level imports.
- **Never remove or downgrade code to silence a type error from an outdated dependency.** Upgrade the dependency instead.
- **Always ask before removing functionality that looks intentional.**
- **Direct dependencies use caret ranges, so treat a `package.json` or `package-lock.json` diff as reviewed code.** Install with `npm install --ignore-scripts`.
- **Stage explicit paths.** `git add <path>...`, never `git add -A`. Only commit the files changed in the current session.
- **Commit messages are `type: imperative summary`** (`feat`, `fix`, `chore`, `docs`, `test`), and the body explains why.
- **After every push, check GitHub Actions before saying it is done.** A green local run is not a green CI: the runner is slower and loaded, and races that never show locally fail there. Watch every run the push started:

  ```bash
  # wait for every run the pushed commit started, then print each outcome
  # (a read loop, not `for id in $ids`: zsh doesn't word-split a variable)
  gh run list --commit "$(git rev-parse HEAD)" --json databaseId -q '.[].databaseId' |
    while read -r id; do
      gh run watch "$id" --exit-status >/dev/null
      gh run view "$id" --json workflowName,conclusion -q '.workflowName + " " + .conclusion'
    done
  gh run view <run-id> --log-failed                     # on failure
  ```

  Give the runs about 15 seconds to appear after the push before listing them. A red run is a bug to fix, not a rerun button: a flaky test usually means a real race in the code or a test that counts something shared. Fix it, push again, and rerun only to confirm the fix.

- **After adding or changing a tool, a skill, a persona or the MCP behaviour, add or update its test file in the same change.** The framework is vitest, one `test/<module>.test.ts` per `src/<module>.ts`.

## Releasing

When the user says "make a release", follow these steps in order.

**1. Pick the bump.**

| Bump | When | Command | Example |
|------|------|---------|---------|
| patch | Bug fixes, small tweaks, internal improvements | `npm version patch --no-git-tag-version` | 0.6.0 to 0.6.1 |
| minor | New user-facing capabilities, non-breaking additions | `npm version minor --no-git-tag-version` | 0.6.0 to 0.7.0 |
| major | Breaking changes, major rewrites, dropped capabilities | `npm version major --no-git-tag-version` | 0.6.0 to 1.0.0 |

The project is pre-1.0, where a minor bump feels like a patch to the users. Use minor for what is worth advertising, and patch for everything else.

**2. Update `docs/changelog.md`.** Add a new `## X.Y.Z` section at the top, with no `v` prefix, matching the existing style. Group the changes under `### Added`, `### Fixed`, `### Changed` and `### Internal` as they apply. Summarize the user-visible impact, not the commit messages.

**3. Run the pre-release checks.** `npm run check && npm test && npm run build`. All three have to pass; fix a failure first.

**4. Commit the release.** `git add package.json package-lock.json docs/changelog.md`, then `git commit -m "chore: bump version to X.Y.Z"`. Include `AGENTS.md` and the other documents if the same session changed them.

**5. Tag and push.** `git tag -a vX.Y.Z -m vX.Y.Z`, then `git push origin master && git push origin vX.Y.Z`. The tag push starts the release workflow on CI.

**6. Verify the release.** `git ls-remote --tags origin vX.Y.Z` to confirm the tag on the remote, `gh run list --workflow=release.yml --limit=1` for the workflow, `gh run view <run-id> --log-failed` if it failed, and `gh release view vX.Y.Z` to confirm the GitHub release exists. If the workflow is still running, wait and check again. Do not call the release done until the Release workflow and the CI run for the release commit both pass: a green Release alone has hidden a red CI before.

## How the engine fits together

- **One provider at a time.** OpenAI-compatible providers are saved in the settings, one named provider is active at a time, and a session keeps the endpoint it used. The eval runner can compare named providers explicitly.
- **Compaction** is LLM-based summarization past a token threshold, with pruning as the fallback.
- **Tool calls within one assistant message** run concurrently through `Promise.all` when they are on the parallel-safe list.
- **Reasoning** is handled in `vendors.ts`: it picks the configured or detected provider dialect, sends that provider's native reasoning control, and normalizes native reasoning plus `<think>` blocks for the user interfaces.
- **Skills and MCP servers** load from the global paths without a check (`~/.cast/skills/`, the agents universal globals). The project paths (`.cast/skills/`, `.agents/skills/`, `.cast/mcp.json`) are trust-gated.
- **MCP** speaks stdio and streamable HTTP, with a legacy HTTP+SSE fallback. Tool names are namespaced `mcp_<server>_<tool>`.
- **Two interactive surfaces** share the same core loop: the pi-tui terminal screen and the optional web server with its REST and SSE bridge. The non-interactive `cast run` remains a readline and JSONL protocol.
- **`evals/`** deliberately uses real configured providers. Its normal run is diagnostic, with one attempt. `--scoreboard` runs exactly three fresh attempts per case, so the numbers can be compared.

The product truth lives in `PRODUCT.md`, and the visual system in `DESIGN.md`. Read them before changing the behaviour or the look, and change the record with the code.
