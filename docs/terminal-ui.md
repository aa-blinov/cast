# The terminal screen

`cast` opens a full-screen interface in your terminal. It is built on [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) and keeps its own place in the conversation, so nothing that arrives while you read moves you. This page is the tour: what is on the screen, how to type, scroll and choose, how to make it fit a phone or a wide monitor, and how to get back to a session. The commands are in [Interactive Commands](interactive-commands.md), the look in [Themes](themes.md).

```bash
cast                      # start (a new session in this folder)
cast "explain this repo"  # start with a first message
cast -c                   # continue the latest session of this folder
cast --resume             # pick a session: this folder's first, all of them one row away
```

## What you see

```
CAST(1) * v0.52.3
/ commands * /settings * Esc Esc stops a turn * PageUp scrolls * Ctrl+C twice quits

YOU
    run ls on src and show a short example

  * bash ls src
AGENT
    src has 6 folders: core, ui, ui-pi, server, pickers, test.

────────────────────────────────────────────────────────────────
   ask cast to do anything
────────────────────────────────────────────────────────────────
Senior Developer * BUILD * mimo-v2.6-flash * ~/pet/cast * ctx 9.1k/168k (5%) * took 3s
```

- **Header.** `CAST(1)` and the version, joined by ` * `. The persona and the model are in the status row below, so the header keeps only the name; `/header` can bring back the persona, the model or the folder, and sets their order. On a narrow screen the parts at the end drop first, whole.
- **Hint row.** The keys worth remembering; it drops hints from the end when the screen is narrow.
- **The conversation** reads like a man page. Whoever speaks is a bold heading (`YOU`, `AGENT`, and `REASONING` when you have turned reasoning on), and the text sits four columns in; code sits four columns further. There are no coloured stripes: weight and indent do the work.
- **Tool rows** sit at the same margin: `* bash ls src` is a finished call, `… bash …` one that is running, `✗ bash … failed` one that failed. The tool name is bold, the arguments quiet. A bash row ends with the deadline it runs under, the default or the one the model chose: ` * timeout 3m`. A long command is cut with an ellipsis while it runs, but the deadline stays; once finished it wraps in full under its text.
- **The composer** is the text between the two lines. While a turn runs, whatever you type steers it.
- **The status row** is one row joined by ` * `: persona, mode (`BUILD` or `PLAN`), model, the working folder (`~/pet/cast`), the share of the context used (`ctx 9.1k/168k (5%)`, amber from 70%, red from 90%), and `took 3s` once a turn ends. Choose and order the segments with `/statusbar`.
- **Notices** (`Cancelled — …`, `New session: …`) appear in one line above the composer.

## Typing

| You want | Do |
|----------|----|
| Send | Enter |
| A line break | Shift+Enter or Alt+Enter; on any terminal, end the line with `\` and press Enter |
| A command | Type `/`: a list opens; keep typing to filter, ↑↓ to move, Tab or Enter to take it |
| A skill in the middle of a message | Type `/` after other text (`review it with /fo`): the skills that match open as a list; Tab takes one. Enter sends what you typed unless you moved the highlight with the arrows, so a word or a path with a slash is never turned into a skill |
| A file | Type `@` and part of a name; ↑↓ choose, Tab or Enter insert `@path` |
| Complete a path | Tab, in a word that looks like one (has a `/`, or starts with `~`) |
| An image | Ctrl+G attaches the one on your clipboard |
| Edit a long draft in your editor | Ctrl+X (`$VISUAL`, then `$EDITOR`) |
| Recall an earlier prompt | ↑ / ↓ walk through them |
| Clear the draft | Ctrl+L |
| Steer a running turn | Just type and press Enter |
| Stop a turn | Esc twice within two seconds |
| Leave | Ctrl+C twice within two seconds (or `/quit`) |

A command you mistype is not sent to the model: `/nonsense` says `Unknown command /nonsense` and suggests the nearest ones. A path that starts with a slash (`/tmp/shot.png`) is still text. All keys can be rebound; see [Interactive Commands](interactive-commands.md#keybindings).

## Reading and scrolling

The wheel or trackpad, PageUp / PageDown, Home / End (top and bottom of the conversation) and Ctrl+↑ / Ctrl+↓ (previous and next prompt) scroll. While you are away from the end a `↓ newest` label shows at the bottom; click it, or press End, to jump back. New output never pulls you down, and a resize keeps your place. PageUp at the very top loads older turns of a resumed session, and Ctrl+Shift+F searches the conversation.

Dragging with the mouse selects and copies on release. If that gets in the way of your terminal's own selection, hold Shift (most terminals give selection back), or start with `CAST_NO_MOUSE=1` and scroll with the keyboard.

Reasoning is hidden by default. Turn it on with `/rd` or in `/settings`; it then appears as a quiet `REASONING` section above the answer.

## Choosing things

Pickers (`/model`, `/persona`, `/sessions`, …) are boxes with a bold title. The footer says what the keys do and keeps the important ones when the box is narrow:

- ↑↓ move, Enter confirm, Esc close; type to filter a list that has a filter.
- A list with two views (your folder's sessions and all of them) flips with ← / →.
- A date, a count or a setting's value sits against the right edge and keeps its room; the label gives way.
- A permission question (`Allow this?`) shows the reason and the full command. Press `y` to allow once, `a` to always allow, `n` to block; Esc blocks too.

### Settings in one place

`/settings` is a screen, not a menu of commands. ↑↓ move; Space or Enter flips a switch (`[x] on` / `[ ] off`); ← / → cycles a choice such as the permission mode or the theme and applies it at once. A row that needs its own list or prompt (model, provider, persona, skills, MCP servers, the iteration cap) opens it and brings the screen back after. Esc closes. Everything it changes is saved to `~/.cast/settings.json`, and each setting still has its own command (`/theme`, `/permissions`, `/web`, `/turn-cap`, `/header`, `/statusbar`).

## Making it fit

The conversation follows the width of the terminal up to 120 columns: text, headings, code and tool rows use all of it on a laptop or a phone, and stop at 120 on a wider screen, while the header, composer and status row use the full width. On a phone or a narrow window:

- the header and hints drop their trailing parts instead of being cut in the middle of a word;
- a long line of code wraps under its own indent;
- pickers cover the width with a centred box (at most 104 columns), their footers keep the exit key, and a session row keeps its date and message count.

Use `/header` and `/statusbar` to keep only what you want on a small screen (for example, just the model and the context).

## Colour, themes and plain terminals

The default theme is `man`: the terminal's own background, one ochre accent for the chosen row and for commands and paths, quiet grey for secondary text, red for failure. `/theme` or the Theme row in `/settings` switches among 20 themes; `cast-light` is made for a light terminal. Whatever the theme, text colours are lifted to a 4.5:1 contrast against your terminal's own background when a theme would fall short.

| If your terminal… | Do |
|-------------------|----|
| shows no colour, or you prefer none | set `NO_COLOR=1`; bold and underline remain and meaning is carried by marks (`>`, `[x]`) and words |
| has no 24-bit colour (macOS Terminal, many ssh clients) | nothing: cast uses 256 colours when `COLORTERM` does not say truecolor |
| is not UTF-8 (`LANG=C`) | nothing: boxes and arrows are drawn as `+-|`, `>`, `~` automatically; `CAST_ASCII=1` forces that, `CAST_ASCII=0` turns it off |
| answers mouse input badly | `CAST_NO_MOUSE=1` |

## Leaving and coming back

When you quit, the screen disappears with its session id, so cast prints the way back:

```
Resume this session: cast --resume=mupcoslvgajl0k
```

A session with no turn in it (nothing said, or cleared with `/clear` or `/new`) prints `cast --continue` instead, if the folder has earlier sessions.

To have that command waiting in your **shell history** — press Up after cast closes — add the function once:

```bash
cast shell-init >> ~/.zshrc      # zsh; use ~/.bashrc for bash, or `cast shell-init fish`
```

then open a new terminal. The function runs the real `cast` and, when a session ends, adds `cast --resume=<id>` to the history. (A program cannot write its parent shell's history itself, which is why this is a function in your shell.) Inside cast, `/sessions` switches session (this folder's first), `/continue` jumps to the latest, and `/fork` branches one.

## When something looks wrong

| You see | Cause and fix |
|---------|---------------|
| `cast needs an interactive terminal` | cast was started in a pipe or without a TTY; use `cast run` for scripts |
| Boxes drawn as `+---+` | your locale is not UTF-8 (see above); set `LANG=en_US.UTF-8` or `CAST_ASCII=0` |
| Text is hard to read | try `/theme`; a light terminal wants `cast-light` |
| A command says `Unknown command` | check the spelling; `/help` lists the commands |
| The screen looks garbled after a resize | resize the window once more; cast redraws on every size change |

## Speed and memory in long sessions

The conversation is laid out once per message and kept, so a frame costs little however long the session is. Two
things are done on purpose so that a long history never freezes the screen:

- **A resize or a theme change is laid out a little at a time.** Each frame re-lays-out the newest messages first, up
  to about 12 ms, and the older ones keep their previous layout until the following frames reach them; typing and
  scrolling stay live meanwhile.
- **A tool call's summary stops at 1,500 characters** and says how many more there are. A heredoc that writes a file, or
  the arguments of a tool with no summary of its own, can be megabytes.

The copies kept for `/undo` of files git does not track (ignored or outside the repository) are capped at 64 MB per
session; the oldest are dropped first, and `/undo` says which files it could not put back.

To check all of this on your machine, run the soak test: `npm run build && npm run soak:tui` (`-- --quick` for a short
run). It starts a throwaway daemon and a TUI in tmux against a fake provider that streams text, reasoning and tool
calls, then fills the transcript, scrolls (wheel and keys, also while a turn streams), resizes the window, opens and
closes pickers, rewrites a 256 KB file (`--edit-kb 1024` for an extreme one) and clears the session, over and over. For the TUI and the daemon it reports the
live heap after a forced GC (read over the inspector, so a leak shows as memory that does not come back), RSS, the
longest the event loop stalled, and how long a typed character takes to appear while a turn streams. It exits non-zero
when the heap does not return to near its start after `/clear`, grows across identical cycles, or the loop stalls for
more than 250 ms (`--lag-budget`, `--heap-budget`, `--slope-budget`, `--turns`, `--lines`, `--cycles` for more
fill-and-clear cycles, `--edit-kb` and `--keep` adjust it). `--force-stream-drops` makes the daemon cut the TUI's event
stream mid-turn, to check that the screen comes back to idle after reconnecting. CI runs it weekly
(`.github/workflows/soak.yml`) and on demand, not on every push: it needs tmux and a few minutes.

What is deliberately left as it is, with the numbers behind it:

- **The whole transcript is held and walked once per frame.** A frame costs about 2 ms at a thousand messages and about
  60 ms at ten thousand (325,000 rows); pi-tui's scroll view needs every row to size itself. Older messages cannot be
  dropped from memory safely, because the rows on screen carry no sequence number to load them back by.
- **A turn's end re-reads the session from SQLite** (to refresh what `/copy` and the status row use): 11 ms for a 2 MB
  session, 59 ms for 8 MB, 283 ms for 63 MB.
- **The daemon builds each model request from the whole history**, so a turn pays for the size of the session in JSON
  serialization (about 170 ms per megabyte of tool arguments in the history in the soak test).
- **`/clear` keeps the `/undo` copies** (within the 64 MB cap): undoing a turn's file changes does not depend on the
  conversation text.
