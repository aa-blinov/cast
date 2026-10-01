# Design

The cast TUI (`src/ui-pi`). Direction contract: `.impeccable/surfaces/src-ui-pi.md`. Product truth: `PRODUCT.md`.

## Thesis

The conversation is set like a man page. Rank comes from weight and case; state from a mark and a word; colour is held back. Nothing paints the page: the terminal's own foreground and background carry everything.

## Structure

- **Header row:** `CAST(1) * persona * model * v<version> * folder`, joined by one ` * ` rather than padded to the edges (which a phone cannot spare); parts drop from the end, whole, when the width is short. The parts and their order are the user's (`/header`). A muted hint row follows, dropping hints from the end.
- **Measure:** conversation text is held to 100 columns however wide the terminal is; the header, composer and status row use the full width.
- **Sections:** a blank row, a bold capitalised heading flush left (`YOU`, `AGENT`, `REASONING`; reasoning heading muted), then the text at a 4-column indent. Code is indented 4 further. A continued block has no heading.
- **Tool rows:** a 4-column margin that is `  * ` when done, `  … ` while running (accent), `  ✗ ` plus the word `failed` on failure (error). Tool name bold, summary muted.
- **Notices:** a blank row and muted text at the indent. Errors: `  ✗ ` and red text. Retries: a warning-coloured sentence.
- **Composer:** a hairline rule above and below, plain placeholder, no gradient.
- **Status row:** `persona | mode | model` left (persona bold, mode muted, plan mode warning), `ctx` and elapsed right; `took Ns` after a turn; the context figure turns warning at 70% and error at 90%.
- **Modals:** a muted hairline box with a bold title, centred and at most 104 columns wide, the columns either side blanked; bold capitalised group headings in settings; the chosen row on a band with a `▸` marker; footer hints in muted text.

## Colour

Restrained: neutrals plus one accent. The `man` theme: accent ochre `#d8a657` (chosen row, commands, paths, running marker), muted `#8a8f98`, success `#a9b665`, warning `#e78a4e`, error `#ea6962`; bold and underline are the emphasis. Every text colour is lifted to 4.5:1 against the background it is drawn on (the terminal's own when it reports it); rules and scrollbar use the rail grey as given. With `NO_COLOR` set no colour is drawn and bold remains. Any theme may supply these colours; the structure does not change with the theme.

## Type

The terminal's font, one size. Hierarchy is bold, capitals and indent only. Separators are ASCII: ` * ` between header parts and hints, `|` in the status row.

## Do not

Coloured left stripes, gradient text or rules, capitals in muted tracked labels above a heading, a band behind a turn, accent-coloured borders, meaning carried by colour alone.
