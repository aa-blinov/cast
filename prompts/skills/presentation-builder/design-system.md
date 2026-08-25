# Design system — five style presets

Tokens and helpers for PptxGenJS. Pick **one** preset per deck and stay inside it. Mixing presets slide-by-slide looks like clip art.

## Common to all presets

- **Aspect:** 16:9 widescreen → `pptx.layout = "LAYOUT_WIDE"` (13.333 × 7.5 in)
- **Margins:** 0.5 in left/right, 0.4 in top
- **Footer:** y=7.15, height 0.25 in
- **Title block:** y=0.4, h=1.4 (fits 2 lines at the preset's title size)
- **Subtitle:** y=1.95, h=0.5
- **Content:** y=2.55, max h=4.4 (capped so it doesn't crash into the footer)
- **Cyrillic rule:** if any title contains Russian / Cyrillic, drop the title size by ~2pt and add `fit: "shrink"` on the title text frame.

---

## Preset 1 — `minimal`

**Use for:** investor decks, sales decks, anything where the content should breathe. The default if nothing else fits.

**Palette:**

```js
const COLOR = {
  ink:       "0E1116",  // primary text
  inkSoft:   "3D434B",  // secondary text
  muted:     "6B7280",  // captions, footer
  bg:        "FFFFFF",
  surface:   "F7F8FA",  // callout cards
  border:    "E5E7EB",
  brand:     "2563EB",  // single accent (blue)
  brandSoft: "DBEAFE",
};
```

**Typography:** Inter for everything. Title 30pt (28pt for Cyrillic), subtitle 15pt italic, body 14–16pt, footer 9pt muted, title-slide wordmark 96pt bold.

**Accent treatment:** left-border bar that grows with the title block height (NOT a horizontal rule — a horizontal rule below the title floats when the title wraps to 2 lines).

**Card helper:**

```js
function addCard(slide, x, y, w, h, opts = {}) {
  slide.addShape("rect", {
    x, y, w, h,
    fill: { color: opts.fill || "F7F8FA" },
    line: { color: "E5E7EB", width: 1 },
  });
  if (opts.accent) {
    slide.addShape("rect", {
      x, y, w: 0.08, h,
      fill: { color: "2563EB" }, line: { color: "2563EB" },
    });
  }
}
```

**Title helper:**

```js
function addTitle(slide, text, opts = {}) {
  const size = opts.size || 30;
  slide.addText(text, {
    x: 0.7, y: 0.4, w: 12.1, h: 1.4,
    fontFace: "Inter", fontSize: size, bold: true,
    color: "0E1116", valign: "bottom",
    wrap: true, fit: "shrink",
  });
  slide.addShape("rect", {
    x: 0.5, y: 0.4, w: 0.12, h: 1.4,
    fill: { color: "2563EB" }, line: { color: "2563EB" },
  });
}
```

**Why left-border, not horizontal rule:** a horizontal rule below the title stays at a fixed y. When the title wraps to 2 lines, the rule floats in the middle of the text and looks broken. A left border grows with the title height and stays attached.

**Footer:**

```js
function addFooter(slide, brand = "Brand", year = new Date().getFullYear()) {
  slide.addText(brand, {
    x: 0.5, y: 7.15, w: 2, h: 0.25,
    fontFace: "Inter", fontSize: 9, color: "6B7280", bold: true,
  });
  slide.addText(`Investor Deck · ${year}`, {
    x: 10.5, y: 7.15, w: 2.4, h: 0.25, align: "right",
    fontFace: "Inter", fontSize: 9, color: "6B7280",
  });
}
```

**Anti-patterns:** title size 36pt with Russian text (wraps and breaks layout); two accent colors (blue + red); gradients on cards; emoji in headings.

---

## Preset 2 — `corporate`

**Use for:** internal reviews, board decks, McKinsey-style strategy decks. Denser grid, more text per slide, calmer color story.

**Palette:**

```js
const COLOR = {
  ink:       "0F172A",  // near-black slate
  inkSoft:   "334155",  // body text
  muted:     "64748B",  // captions, footer
  bg:        "FFFFFF",
  surface:   "F1F5F9",  // slightly darker callout than minimal
  border:    "CBD5E1",
  brand:     "1E3A8A",  // deep steel blue (NOT the bright minimal blue)
  brandSoft: "DBE5F5",
  rule:      "94A3B8",  // thin divider lines
};
```

**Typography:** Inter for everything. Title 24pt bold (smaller than minimal — denser slide), subtitle 13pt regular in `inkSoft`, body 12–13pt, captions 9–10pt, footer 9pt. Wordmark 72pt bold on title slide (smaller because corporate decks usually have longer titles).

**Accent treatment:** thin top accent rule (full width 12.3 in, 0.04 in tall, sits at y=0.35) ABOVE the title block — gives a "letterhead" feel. Title sits at y=0.55, h=1.0. Cards use a `rule`-colored 1pt border, no fill.

**Card helper:**

```js
function addCard(slide, x, y, w, h, opts = {}) {
  slide.addShape("rect", {
    x, y, w, h,
    fill: { color: opts.fill || "FFFFFF" },
    line: { color: opts.border || "CBD5E1", width: 1 },
  });
  if (opts.accent) {
    // thin top rule instead of left border
    slide.addShape("rect", {
      x, y, w, h: 0.04,
      fill: { color: "1E3A8A" }, line: { color: "1E3A8A" },
    });
  }
}
```

**Title helper:**

```js
function addTitle(slide, text) {
  // top rule
  slide.addShape("rect", {
    x: 0.5, y: 0.35, w: 12.3, h: 0.04,
    fill: { color: "1E3A8A" }, line: { color: "1E3A8A" },
  });
  slide.addText(text, {
    x: 0.5, y: 0.55, w: 12.3, h: 1.0,
    fontFace: "Inter", fontSize: 24, bold: true,
    color: "0F172A", valign: "bottom",
    wrap: true, fit: "shrink",
  });
}
```

**Grid density:** default to 3 columns or a 2×2 grid; corporate decks read denser than sales decks. Tables are first-class citizens — use them when a slide is mostly numbers.

**Anti-patterns:** left-border accent (that's minimal); hero-sized titles (this preset is for dense content); bright blue (use the deep `1E3A8A` only).

---

## Preset 3 — `bold`

**Use for:** conference talks, product launches, sales kickoffs. High energy, big type, dark backgrounds optional.

**Palette (light variant):**

```js
const COLOR = {
  ink:       "0A0A0A",  // near-black
  inkSoft:   "404040",
  muted:     "A3A3A3",
  bg:        "FFFFFF",
  surface:   "F5F5F5",
  brand:     "FF3B30",  // red as accent — works for bold
  brandSoft: "FFE5E3",
};
```

**Palette (dark variant — flip `bg` and `ink`):**

```js
const COLOR = {
  ink:       "FAFAFA",
  inkSoft:   "D4D4D4",
  muted:     "737373",
  bg:        "0A0A0A",
  surface:   "171717",
  brand:     "FF3B30",  // or pick a neon: "00FF88", "8B5CF6"
  brandSoft: "2A1010",
};
```

**Typography:** Inter or Geist (Geist if available). Title 44pt bold (oversized on purpose). Subtitle 18pt regular in `inkSoft`. Body 18–20pt. Footer 10pt. Title-slide wordmark 120pt bold.

**Accent treatment:** big color block on the left edge — full-height strip 0.6 in wide (NOT 0.12 like minimal). When the brand color is the brand itself, the strip IS the brand statement.

**Card helper:**

```js
function addCard(slide, x, y, w, h, opts = {}) {
  if (opts.fill === "none") {
    // outlined card on dark bg
    slide.addShape("rect", {
      x, y, w, h,
      fill: { type: "none" },
      line: { color: opts.border || "404040", width: 2 },
    });
  } else {
    slide.addShape("rect", {
      x, y, w, h,
      fill: { color: opts.fill || "F5F5F5" },
      line: { color: opts.border || "F5F5F5", width: 0 },
    });
  }
}
```

**Title helper (with oversized brand strip):**

```js
function addTitle(slide, text) {
  slide.addShape("rect", {
    x: 0, y: 0, w: 0.6, h: 7.5,
    fill: { color: "FF3B30" }, line: { color: "FF3B30" },
  });
  slide.addText(text, {
    x: 1.2, y: 0.5, w: 11.5, h: 1.5,
    fontFace: "Inter", fontSize: 44, bold: true,
    color: "0A0A0A", valign: "bottom",
    wrap: true, fit: "shrink",
  });
}
```

**Anti-patterns:** two accent colors (red + anything else); pastel palettes (this preset commits to saturated); small text (defeats the point — if you can read it from the back row, it might be too small).

---

## Preset 4 — `technical`

**Use for:** tech overviews, architecture reviews, engineering audits, RFCs. Looks like a polished IDE / Linear doc.

**Palette:**

```js
const COLOR = {
  ink:       "E4E4E7",  // near-white (default bg is dark)
  inkSoft:   "A1A1AA",
  muted:     "71717A",
  bg:        "0B0B0F",  // near-black with a hint of blue
  surface:   "13131A",
  border:    "27272A",
  brand:     "22D3EE",  // cyan accent (alternatives: "10B981" green, "A78BFA" violet)
  brandSoft: "0E2A33",
};
```

**Typography:** Inter for UI text, JetBrains Mono (or Roboto Mono) for code, paths, command names. Title 28pt bold, subtitle 13pt regular in `inkSoft`, body 13–14pt, code/labels 11pt monospace. Footer 9pt monospace `muted`.

**Accent treatment:** thin top accent line (full-width 0.04 in at y=0.35) + monospace eyebrow text above the title (e.g. `> ARCHITECTURE` or `# eora/tech-overview`).

**Card helper:**

```js
function addCard(slide, x, y, w, h, opts = {}) {
  slide.addShape("rect", {
    x, y, w, h,
    fill: { color: opts.fill || "13131A" },
    line: { color: "27272A", width: 1 },
  });
}
```

**Title helper:**

```js
function addTitle(slide, text, eyebrow = "") {
  if (eyebrow) {
    slide.addText(eyebrow, {
      x: 0.5, y: 0.35, w: 12.3, h: 0.3,
      fontFace: "JetBrains Mono", fontSize: 11,
      color: "22D3EE", charSpacing: 2,
    });
  }
  // thin top rule under eyebrow
  slide.addShape("rect", {
    x: 0.5, y: 0.7, w: 12.3, h: 0.02,
    fill: { color: "27272A" }, line: { color: "27272A" },
  });
  slide.addText(text, {
    x: 0.5, y: 0.85, w: 12.3, h: 1.1,
    fontFace: "Inter", fontSize: 28, bold: true,
    color: "E4E4E7", valign: "bottom",
    wrap: true, fit: "shrink",
  });
}
```

**Code blocks:** when showing commands or paths, use `JetBrains Mono` 11–12pt, color `ink` on a `surface` rectangle. Indent with two leading spaces in `addText` strings or use a smaller text frame at the right coordinates.

**Anti-patterns:** light background (this preset is dark); gradients (the surface color is enough); emoji or decorative shapes (this preset is functional).

---

## Preset 5 — `editorial`

**Use for:** long-form decks, research presentations, internal magazines, conference proceedings. Reads like the New York Times or a Stripe Press publication.

**Palette:**

```js
const COLOR = {
  ink:       "1A1A1A",
  inkSoft:   "4A4A4A",
  muted:     "8C8C8C",
  bg:        "FBF8F1",  // off-white, slightly warm
  surface:   "F1ECDF",  // card / pull-quote background
  border:    "D9D2BD",  // warm gray border
  brand:     "B45309",  // sepia / burnt-orange accent
  brandSoft: "F5E6D0",
};
```

**Typography:** Source Serif 4 (or Lora / Georgia fallback) for headings and pull-quotes. Inter for body and captions. Title 32pt serif, subtitle 16pt italic serif, body 14–15pt Inter, captions 10pt Inter, footer 9pt Inter `muted`.

**Accent treatment:** centered title with a horizontal rule under it (NOT left-border). The rule sits at y = (title block bottom + 0.15). Title is centered in the slide, body is left-aligned within a narrower content column (max width 10 in instead of 12.3).

**Card helper (used sparingly — editorial decks prefer whitespace over cards):**

```js
function addPullQuote(slide, x, y, w, h, text) {
  slide.addShape("rect", {
    x, y, w, h,
    fill: { color: "F1ECDF" },
    line: { color: "F1ECDF", width: 0 },
  });
  slide.addText(text, {
    x: x + 0.3, y: y + 0.2, w: w - 0.6, h: h - 0.4,
    fontFace: "Source Serif 4", fontSize: 18, italic: true,
    color: "1A1A1A", valign: "middle", align: "left",
  });
}
```

**Title helper:**

```js
function addTitle(slide, text) {
  slide.addText(text, {
    x: 1.65, y: 0.6, w: 10, h: 1.2,
    fontFace: "Source Serif 4", fontSize: 32, bold: true,
    color: "1A1A1A", valign: "bottom", align: "center",
    wrap: true, fit: "shrink",
  });
  // horizontal rule below title
  slide.addShape("rect", {
    x: 5.66, y: 1.95, w: 2, h: 0.03,
    fill: { color: "B45309" }, line: { color: "B45309" },
  });
}
```

**Content width:** centered body, max width 10 in, left margin = right margin = 1.65 in.

**Anti-patterns:** left-border accent (that's minimal/technical); bright blue or red (use the sepia accent only); dense 3-column grids (editorial prefers 1–2 columns and more whitespace).

---

## Tables (any preset)

```js
slide.addTable(rows, {
  x: 0.5, y: 2.55, w: 12.3,
  fontFace: "Inter", fontSize: 13, color: "0E1116",
  border: { type: "solid", color: "E5E7EB", pt: 1 },
  valign: "middle",
});
```

Header row gets `fill: { color: "0E1116" }, color: "FFFFFF"`, `bold: true`. For `corporate` and `editorial` presets, use the preset's border color instead of `E5E7EB`.

## Speaker notes

Every content slide gets notes — what the presenter says in 30 seconds and what to say if the audience pushes back:

```js
slide.addNotes(
  "30 sec. Why this matters: commoditization + on-prem demand. " +
  "If asked why not just Cursor: 'We're a layer under, not a replacement.'"
);
```

## Generating the deck

```bash
node build-pptx.js                    # → deck.pptx
soffice --headless --convert-to pdf deck.pptx
pdftoppm -png -r 110 deck.pdf slide   # → slide-01.png ... slide-NN.png
```

Inspect: open each PNG directly with `read` (see Step 5 in `SKILL.md`). Do not trust `node build-pptx.js` exit code — that's not evidence the slide looks right.

## Adding a new preset

When the user asks for a style the five presets don't cover:

1. Pick the closest preset as a starting point.
2. Copy its section into a new `## Preset N — <name>` block above.
3. Update the palette, typography, accent treatment, and helpers.
4. Add a row to the table in `SKILL.md` Step 1.
5. Document one or two decks you've shipped with it in `examples/`.

Don't freelance inside a deck. New style = new preset section, documented and reusable.
