# Verification checklist — slide-by-slide

Run this after `node build-pptx.js`, `soffice`, and `pdftoppm`. Every item is PASS / FIX. Don't ship until all PASS.

The exact list of per-slide items depends on the **style preset** chosen in Step 1 of `SKILL.md` — but the **universal checks** below apply to every preset.

## How to inspect

Open each `slides-png/slide-NN.png` directly with `read` — no server or browser needed.

## Universal checks (every slide, every preset)

- [ ] No element overlaps another (text-on-text, accent-on-text)
- [ ] Footer (or its preset equivalent) is visible, not cut off
- [ ] No element touches the slide edge with < 0.2 in margin
- [ ] Single accent color is used; no rogue reds/greens/yellows that don't belong to the preset
- [ ] Preset discipline: no foreign elements from another preset leaked in (e.g. a `corporate` slide with `bold`-style huge type, or a `minimal` slide with sepia serif)
- [ ] Cyrillic titles fit on 2 lines max and don't crash into the accent element

## Preset-specific top defects

### `minimal`

- [ ] Left-border accent bar grows with the title block height — not stranded mid-text
- [ ] Body bullets don't have a huge empty gap above them when `valign` defaults to center
- [ ] Bullets render as `•` — not as missing markers (use `bullet: true` per item, not `bullet: { type: "bullet" }` with `\n`)
- [ ] Footer reads "Brand" left and "Investor Deck · YEAR" right in 9pt muted

### `corporate`

- [ ] Top accent rule is 0.04 in thin, full-width, at y=0.35 — not a chunky block
- [ ] Title sits at y=0.55 below the rule — not floating mid-slide
- [ ] Cards use a 1pt `border` outline, NOT the `surface` fill from minimal
- [ ] Tables look denser than minimal (12pt body, smaller margins)
- [ ] Deep steel blue (`1E3A8A`) is the only accent — not the bright `2563EB`

### `bold`

- [ ] Big left-edge color strip is 0.6 in wide (full height), not the minimal 0.12 in
- [ ] Title type is oversized (44pt) — if it looks like minimal, you didn't commit
- [ ] Dark variant has `bg: "0A0A0A"` and white text — not dark blue ink on light bg
- [ ] Cards (if any) are either filled in surface color or outlined with a 2pt rule, never both
- [ ] Body text is large (18–20pt) — readable from the back of the room

### `technical`

- [ ] Background is dark (near-black) — light bg means you're in the wrong preset
- [ ] Eyebrow text above the title is monospace, in accent color, with charSpacing
- [ ] Code / path / command snippets use `JetBrains Mono` (or Roboto Mono fallback), not Inter
- [ ] The single accent is cyan / green / violet — NOT blue, red, or sepia
- [ ] No gradients, no decorative shapes — the surface color and 1pt borders are the only chrome

### `editorial`

- [ ] Background is off-white (`FBF8F1`), not pure white
- [ ] Title font is serif (Source Serif 4 / Lora / Georgia), not Inter
- [ ] Title is centered horizontally (around x=6.165) — not left-aligned
- [ ] Horizontal rule below the title is short (2 in wide), centered, in sepia accent
- [ ] Body content is constrained to a centered column ~10 in wide — not full-width 12.3

## Per-slide universal checks

For every slide that has these elements, check:

### Slide 1 (Title)

- [ ] Wordmark descenders ('t', 'g', 'p', 'у', 'д') have clearance — not touching subtitle
- [ ] Subtitle is dimmer than main title (italic, lighter color)
- [ ] Bottom URL / contact line doesn't crash into footer

### Slides with long Russian titles

- [ ] Title fits in 2 lines max; if it wraps, both lines have visual weight
- [ ] Accent element grows with title height — not stranded mid-text
- [ ] Body bullets have ≥ 0.3 in gap below the title block

### Slides with cards / grid

- [ ] All cards have the same height — visual rhythm matters
- [ ] Citation text at bottom of each card, not floating mid-card
- [ ] Grid aligns to a single baseline (no card "sinking" by a few px)

### Slides with 4-column grid

- [ ] All column headers fit on one line (or all wrap the same way)
- [ ] Accent underlines under headers don't crash into body text
- [ ] Body text uses `wrap: true` — no horizontal overflow

### Slides with code / monospace

- [ ] Window dots row (if any) aligned across terminals
- [ ] Code lines monospace, no proportional font bleed
- [ ] Indentation preserved (don't lose leading spaces in `addText` strings)

### Slides with metrics / numbers

- [ ] All metric values fit on one line — short numeric or `[—]`
- [ ] Metric label sits below the value, not overlapping
- [ ] If you reference a doc path, the URL doesn't wrap (or you shorten it)

### Slides with tables

- [ ] Header row dark, body rows white — high contrast
- [ ] Currency cells aligned right (or consistent)
- [ ] SAM/SOM callout below doesn't merge with footer

### Slides with tiered cards (3 tiers)

- [ ] Highlight tier (middle) is visually distinct — bg color, not size
- [ ] All tier cards have the same height
- [ ] Price font weight matches tier-name weight

### Slides with team / people

- [ ] Founder cards aligned horizontally
- [ ] Co-founder card height matches founder card
- [ ] Hiring band at bottom doesn't crash into footer

### Last slide (CTA / ask)

- [ ] Round / use of funds / milestones in clean columns
- [ ] No milestone number takes 2 lines (reformat if it does)
- [ ] Contact band at bottom is high-contrast

## Re-render workflow

1. Edit `build-pptx.js`
2. `node build-pptx.js`
3. `soffice --headless --convert-to pdf deck.pptx`
4. `pdftoppm -png -r 110 deck.pdf slide` (overwrites)
5. `read` each affected slide's PNG
6. Update `verification.md` with PASS / FIX / PASS-AFTER-FIX

**Maximum two re-renders.** If a slide needs three, the structure is wrong — redesign that slide from scratch.

## When to stop

All slides PASS. You deliver `deck.pptx`, `deck.pdf`, and the PNG directory. Done.
