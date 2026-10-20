# Screenshots

There are no screenshots in this folder. cast has no picture of its own
interface, and the folder is here because the standard asks for it.

## What the repository does have

One image, and it lives outside this folder:

| Image | Where it is used | Where it comes from |
| --- | --- | --- |
| `assets/cast-banner.svg` | The banner at the top of the [README](../../README.md). | Hand-written SVG: a wordmark over a gradient bar of squares. The gradient runs from `#38e0ff` to `#a855f7`. |

The browser client also ships `src/server/public/favicon.svg`. The web server
hands it to the browser as the favicon of the sign-in screen and the control
room.

## Why there is nothing else

The terminal screen is drawn by the terminal, and the browser client is a
running application. Neither has a capture in the repository, so there is
nothing to point a screenshot at. The documents that would need one describe
the interface instead: [the terminal screen](../terminal-ui.md) and
[the web UI](../web-ux.md).

## Adding one

Put the file in this folder and reference it by relative path, the way the
README does:

```markdown
![The terminal screen](docs/screenshots/terminal.png)
```

The checker resolves every image reference, so a file that is renamed without
its reference being updated fails the build.
