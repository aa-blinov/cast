# Themes

cast ships with 19 color themes for the TUI (the browser UI lists the 18 dark ones). The active theme is persisted to `~/.cast/settings.json`.

## Built-in Themes

| Theme | ID |
|-------|----|
| Ayu | `ayu` |
| Cast | `cast` (default) |
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

## Readability

Text colours are checked against the background they are drawn on (the terminal's own, when it reports it) and lifted to a 4.5:1 contrast ratio when a theme's palette falls short, so the muted grey of a theme such as Nord stays legible. Set `NO_COLOR` (to anything but empty) and cast draws no colour at all: bold and underline remain, and meaning is carried by markers (`▸`, `●`/`○`) and words.

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
