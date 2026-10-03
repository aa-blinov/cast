---
name: cast
description: A coding agent set like a man page, in the terminal and in the browser.
colors:
  ochre: "#d8a657"
  ink: "#0a0a0b"
  surface: "#141416"
  raised: "#1d1d20"
  hover: "#26262a"
  hairline: "#2a2a2e"
  hairline-active: "#3a3a40"
  rail: "#5c6068"
  text: "#fafafa"
  text-dim: "#a1a1aa"
  muted: "#8a8f98"
  success: "#a9b665"
  warning: "#e78a4e"
  error: "#ea6962"
  scrim: "rgba(0,0,0,.6)"
  scrim-strong: "rgba(0,0,0,.85)"
  on-scrim: "#ffffff"
  shadow-menu: "rgba(0,0,0,.35)"
  shadow-modal: "rgba(0,0,0,.4)"
typography:
  body:
    fontFamily: "JetBrains Mono, Fira Code, SF Mono, Consolas, monospace"
    fontSize: "0.9rem"
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "JetBrains Mono, Fira Code, SF Mono, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
  label:
    fontFamily: "JetBrains Mono, Fira Code, SF Mono, Consolas, monospace"
    fontSize: "0.72rem"
    fontWeight: 600
    letterSpacing: "0.06em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  pill: "999px"
spacing:
  row: "44px"
components:
  session-row:
    textColor: "{colors.text-dim}"
    rounded: "{rounded.sm}"
    height: "44px"
  session-row-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  field:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "44px"
  send-button:
    backgroundColor: "{colors.ochre}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    size: "36px"
---

# Design System: cast

One system on two surfaces: the terminal screen (`src/ui-pi`) and the browser client (`src/server/public`). Direction contract for the terminal: `.impeccable/surfaces/src-ui-pi.md`. Product truth: `PRODUCT.md`.

## Overview

**Creative North Star: "The Man Page"**

The conversation is set like a manual page. Rank comes from weight and case, state from a mark and a word, and colour is held back for what needs it. Nothing paints the page: in the terminal the terminal's own foreground and background carry everything; in the browser one near-black page does the same. The reader spends hours here, so legibility outranks ornament, and the agent's character shows in what it does and says, not in decoration.

The two surfaces differ in medium, not in voice. They share one theme (`man`, the default on both), one accent, one type character (monospace), one vocabulary (` * ` separators, `Esc close`, `[x] on`), and the same refusals.

**Key Characteristics:**
- One ochre accent on at most a tenth of any screen: the chosen row, commands, paths, the running marker, the send button.
- Hierarchy from bold, capitals and indent. No coloured stripes, no gradient text, no glow.
- Monospace everywhere; text follows the terminal's width up to a readable measure (120 columns).
- Meaning is never carried by colour alone: a mark or a word goes with it.
- Degrades gracefully: 40 to 200+ columns, 320 to 1280+ px, `NO_COLOR`, non-UTF-8 terminals.

## Colors

Restrained: neutrals plus one accent. Every theme can supply these roles; the structure does not change with the theme. `man` is the default on both surfaces and is the fallback the browser uses before a theme loads.

### Primary
- **Ochre** (#d8a657): the only accent. Chosen row, commands, paths, running marker, links, the send button, the pixel logo. In the browser it is the `--cyan` custom property (a legacy name, kept because user CSS may reference it); read it as "accent".

### Neutral
- **Ink** (#0a0a0b): the browser page; in the terminal the terminal's own background is used and this is only the fallback.
- **Surface / Raised / Hover** (#141416 / #1d1d20 / #26262a): tonal layers for panels, the active row, and hover.
- **Hairline** (#2a2a2e, active #3a3a40) and **Rail** (#5c6068): rules, box edges, scrollbar. Drawn as given, not lifted.
- **Text** (#fafafa), **Text dim** (#a1a1aa), **Muted** (#8a8f98): primary, secondary and quiet text.

### Status
- **Success** (#a9b665), **Warning** (#e78a4e), **Error** (#ea6962): state only. The context figure turns warning at 70% and error at 90%.

### Named Rules
**The One Voice Rule.** The accent marks state and choice, never decoration. If a second thing is ochre on the same screen, one of them is wrong.

**The Contrast Floor Rule.** Every text colour is held to 4.5:1 against the background it sits on. The terminal lifts colours against the terminal's own background (`legible()`); the browser derives muted and dim text per theme. With `NO_COLOR` no colour is drawn and bold remains.

## Typography

**Font:** the terminal's own in the terminal; JetBrains Mono (with Fira Code, SF Mono, Consolas) in the browser. The browser can switch in Settings among the bundled faces: JetBrains Mono, Fira Code, IBM Plex Mono, and the sans faces Inter, IBM Plex Sans and Work Sans.

**Character:** a manual, set in one voice. Hierarchy is bold, capitals and indent only; there is no display face.

### Hierarchy
- **Body** (400, 0.9rem, 1.5): chat prose and inputs.
- **UI** (400, 0.8rem): controls, rows, metadata.
- **Label** (600, 0.72rem, 0.06em, uppercase): group labels such as TODAY, in muted text, never the accent. In the terminal, section headings (`YOU`, `AGENT`, `REASONING`) are bold capitals flush left with the text four columns in and code four further.

### Named Rules
**The Plain Separator Rule.** Separators are ASCII: ` * ` between header parts, hints and status segments; list markers `*`, `-`, `+` by depth; task boxes `[ ]` / `[x]`; switches `[x] on` / `[ ] off`. A glyph outside the ASCII map breaks the `LANG=C` look (`ui-pi/ascii.ts`).

## Layout

**Terminal.** Header row `CAST(1) * v<version>`, joined by one ` * ` (the persona, model and folder are in the status row; `/header` can bring them back, and the parts and their order are the user's); a muted hint row; the conversation; the composer between two hairlines; a one-row status line `persona * mode * model * folder * ctx … * took Ns` (also the user's, `/statusbar`). Conversation text follows the terminal's width and stops at 120 columns; the header, composer and status row use the full width. Notices sit in the transcript at the indent or in one unbracketed line above the composer; errors use `  ✗ ` and red.

**Browser.** A sidebar of sessions (272px) beside the chat, a header with the connection dot, and the composer at the foot. On a phone (coarse pointer, under 768px) the sidebar is a drawer, the composer tightens, and every control has a 44px target; the page never scrolls sideways at 320px.

Tool rows (terminal) sit at the same margin: `  * ` done, `  … ` running (accent), `  ✗ ` plus the word `failed`. Tool name bold, arguments muted; a bash row ends with the deadline it runs under (` * timeout 3m`, or the one the model chose), kept when a running row is cut to one line; a finished command wraps under its text, not under the margin.

## Elevation & Depth

Flat. Depth is tonal layering (ink, surface, raised, hover) and hairline rules; there is no glow. The one exception is a layer that floats above the page (the menus and the modal), which carries a soft offset shadow so it reads as lifted. The connection dot is colour plus its tooltip, with a pulse only when the connection is genuinely lost. A recording indicator may pulse while recording is live, and stops under reduced motion.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest; state is shown by tone and a mark, not by shadow.

## Shapes

Hairline boxes. Terminal modals are a muted box with a bold title, centred on the screen and at most 104 columns wide. Small inline things (code chips, scrollbar thumbs, tags) use a 4px radius, browser fields and rows 6px, panels 8px; the one pill is the warning badge. No nested cards. Modal and sidebar backdrops, and the remove button on a composer image, are translucent black, the only non-palette colour.

## Components

### Pickers and modals (terminal)
- A muted hairline box, bold title, centred horizontally and vertically; the columns either side are blanked.
- The chosen row sits on a band with a `▸` marker. Group headings in settings are bold capitals.
- The footer is an ordered hint list in muted text with the exit key early (`Esc close`); later hints drop whole when narrow. One vocabulary everywhere (`Enter confirm`, `Esc close`, `↑↓ move`) and one ellipsis, `…`. A list's filter placeholder sits on the prompt row.
- The start-up and loading box is compact: it fits its label, is centred, and shows three running dots (`.`, `..`, `...`) padded to three cells.

### Tool row (browser)
- One line, as in the terminal: a mark (`*` done, `…` running in the accent, `✗` failed in the error colour), the tool name in bold, the one argument it acts on in muted text, truncated with an ellipsis, and the word `failed` at the right edge when it did. No box, no chip, no dot. A click opens the full arguments and the result in inset panels; under a coarse pointer the row is 44px tall.

### Session row (browser)
- 44px tall under a coarse pointer, 6px radius, dim text; the active row is raised with a hairline. Pin and "more" are always visible on touch, shown on hover with a mouse.

### Fields (browser)
- Ink background, hairline border, accent border on focus, 44px tall under a coarse pointer; iOS gets a 16px font floor so focus does not zoom.

### Send button (browser)
- 36px with a 44px hit area, ochre fill. The only filled accent control in the composer.

## Do's and Don'ts

### Do:
- **Do** use the one accent for state and choice and let weight, case and indent do the rest.
- **Do** keep every terminal row within the width (`visibleWidth`, not `.length`) and check at 46, 100 and 160 columns, and the browser at 320 and 390 px.
- **Do** route text colour through `paint()` in the terminal; never write raw SGR codes or hard-code truecolor.
- **Do** keep touch targets at 44px under a coarse pointer, using a larger invisible hit area where the look must stay small.

### Don't:
- **Don't** use gradient text or rules, coloured left stripes, glow shadows, a band behind a turn, or accent-coloured borders.
- **Don't** set muted tracked capitals in the accent colour above a heading.
- **Don't** carry meaning by colour alone.
- **Don't** add a second accent or a purple/cyan palette; a user theme may, the default may not.
