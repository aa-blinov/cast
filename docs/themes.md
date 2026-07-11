# Themes

cast ships with 16 color themes for the TUI. The active theme is persisted to `~/.cast/settings.json`.

## Built-in Themes

| Theme | ID |
|-------|----|
| Ayu | `ayu` |
| Cast | `cast` (default) |
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

The theme is not settable via CLI flags — use `/theme` in the TUI or edit `settings.json` directly.
