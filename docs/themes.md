# Themes

cast ships with 20 color themes for the TUI. The browser UI lists the 18 dark ones; `man` and `cast-light` are terminal-only. The active theme is persisted to `~/.cast/settings.json`.

## Built-in Themes

| Theme | ID |
|-------|----|
| Ayu | `ayu` |
| Man page | `man` (default in the terminal) |
| Cast | `cast` |
| Cast light | `cast-light`, for light terminals (TUI only) |
| Everforest | `everforest` |
| Synthwave '84 | `synthwave-84` |
| Catppuccin | `catppuccin` |
| Dracula | `dracula` |
| GitHub | `github` |
| Gruvbox | `gruvbox` |
| Kanagawa | `kanagawa` |
| Molokai | `molokai` |
| Monokai | `monokai` |
| Night Owl | `night-owl` |
| Nord | `nord` |
| One Dark | `one-dark` |
| Rosé Pine | `rose-pine` |
| Solarized | `solarized` |
| Tokyo Night | `tokyo-night` |
| Tomorrow Night | `tomorrow-night` |

## The look

The terminal screen is set like a man page. The speaker is a bold heading in capitals (`YOU`, `AGENT`, `REASONING`), what they said hangs at a four-column indent, and code sits four columns further in. There is no coloured stripe down the side, no gradient and no band behind your turns: weight and case rank things, and state is a mark and a word (`*` while a tool is done, `…` while it runs, `✗ … failed` when it did not). The header row reads `CAST(1)`, then persona and model, then the version. Colour is held back for the chosen row, commands and paths (one accent, ochre in `man`), muted secondary text, and red for failure.

Any theme can be used with this look; the theme only supplies the accent, muted, success, warning and error colours.

## Readability

Text colours are checked against the background they are drawn on (the terminal's own, when it reports it) and lifted to a 4.5:1 contrast ratio when a theme's palette falls short, so the muted grey of a theme such as Nord stays legible. Set `NO_COLOR` (to anything but empty) and cast draws no colour at all: bold and underline remain, and meaning is carried by markers (`>`, `[x]`/`[ ]`) and words. A terminal whose locale is set and is not UTF-8 (`LANG=C`), or `CAST_ASCII=1`, gets every box, arrow and marker glyph swapped for a one-cell ASCII look-alike (`+---+`, `|`, `>`, `~`); `CAST_ASCII=0` turns that off.

## Changing Themes

### Interactive

```
/theme
```

Opens a picker showing all themes with the current selection highlighted.

### Direct

```
/theme dracula
/theme nord
```

### CLI

The theme is not settable via CLI flags. Use `/theme` in the TUI or edit `settings.json` directly.
