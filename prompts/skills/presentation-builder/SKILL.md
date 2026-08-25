---
name: presentation-builder
description: Build professional slide decks (PPTX/PDF) via PptxGenJS with 5 style presets and PNG verify gate. Use when user asks for презентация, pitch deck, slides, slide deck, investor deck, tech overview, or conference talk. Supports Cyrillic and enforces spec → voice → build → verify workflow.
---

# Presentation builder

A slide deck is a visual document that has to **look right in the room where it's presented** — that's why we verify every slide against the actual render before saying done. Code-level confidence is not evidence.

**Leading words you will see throughout:**
- **spec** — every claim or number must trace to a source on disk or be marked `[—]`. Never invent.
- **voice** — write for the reader, not the author. One slide = one idea.
- **verify** — every slide must be rendered to PNG and opened before shipping.
- **style** — pick the visual preset up front. Don't freelance inside a deck.

## When to use this skill

Trigger on any of:
- "сделай презентацию", "подготовь слайды", "presentation"
- "pitch deck", "investor deck", "sales deck", "partner deck"
- "tech overview", "product overview", "demo day slides"
- "конференция", "доклад", "обучение"

Skip if the user wants a one-pager, a Notion doc, or anything that is not PPTX / PDF.

## Step 1 — Identify intent and pick a style

Before opening PptxGenJS, ask the user (or infer from context) which **style preset** fits the deck. Each preset has its own palette, typography, and accent treatment — but all share the same layout grid and verify workflow.

| Preset | When to use | Palette | Typography | Accent | Mood |
|---|---|---|---|---|---|
| `minimal` | Investor decks, sales decks, anything where content should breathe | Neutral ink + one brand color | Inter, 16:9, generous whitespace | Left-border bar | Restrained, Apple-like |
| `corporate` | Internal reviews, board decks, McKinsey-style | Dark ink + steel blue + light grays | Inter, denser grid | Top accent rule + thin dividers | Conservative, structured |
| `bold` | Conference talks, product launches, sales kickoffs | Dark backgrounds, high-contrast accent | Inter / Geist, oversized type | Big color block on left edge | Confident, kinetic |
| `technical` | Tech overviews, architecture reviews, engineering audits | Near-black + neon accent (cyan/green/violet) | Inter for UI, JetBrains Mono for code | Thin top accent line + monospace accents | Precise, IDE-like |
| `editorial` | Long-form decks, research presentations, internal magazines | Off-white bg, deep ink, sepia accent | Serif headings (Source Serif / Lora) + Inter body | Centered title with horizontal rule | Considered, NYT-like |

Default if the user says nothing: `minimal`.

If the user names an audience (investors, executives, engineers, designers), pick the preset that matches. If multiple match, ask one short clarifying question — don't guess across three styles.

## Step 2 — Spec — gather before you draw

Pull README, changelog, pricing pages, screenshots. Every claim you put on a slide must trace to something on disk or be marked `[—]`.

**Completion criterion:** `spec.md` exists in the deck's working directory with the inputs you actually need for the chosen preset:

- Deck title and one-line subtitle
- Audience (who will read this)
- Goal (inform / persuade / sell / train)
- 3–5 differentiators or key points (or `[—]` if not yet known)
- Traction / metrics (or "none yet")
- Team (or `[—]`)
- Style preset chosen in Step 1
- If asked to produce fewer / more slides than the preset default, the target count

## Step 3 — Voice — write the slide briefs first

Before opening PptxGenJS, draft a one-line brief for every slide in `deck-spec.md`:

- one slide = one idea (one paragraph, not five)
- lead with the benefit or takeaway, not the mechanism
- if you can't defend a number, write `[—]` and stop
- the brief traces to either `spec.md` or a `[—]` marker

A typical 10-slide ordering for a tech/product deck:

1. Title
2. Context (what is this about, why now)
3. The thing (one-screen product overview)
4. How it works (architecture / flow)
5. What's in it for the audience (value)
6. Evidence (metrics / customers / screenshots)
7. Edge cases / FAQ / risks
8. Roadmap or next steps
9. Team / about
10. Call to action (contact, ask, demo)

Adjust for the actual content — this is a default, not a rule.

**Completion criterion:** `deck-spec.md` exists, every slide is one paragraph, no slide is "TBD".

## Step 4 — Build with the style system

Use [`design-system.md`](design-system.md). It is opinionated, but it ships **five style presets** instead of one. Pick one in Step 1 and stay inside it for the whole deck. Mixing presets slide-by-slide looks like a 2008 clip-art show.

Common to all presets:
- 16:9 widescreen (`pptx.layout = "LAYOUT_WIDE"`, 13.333 × 7.5 in)
- Title block at y=0.4 with a height that accommodates 2 lines
- Footer at y=7.15
- Speaker notes on every content slide
- One accent color per deck (the preset's accent)

Per-preset differences (palette, typography, accent treatment, default grid) live in [`design-system.md`](design-system.md). Read the section for the preset you chose before writing the builder.

**Completion criterion:** `build-pptx.js` runs without error and produces `deck.pptx`. Speaker notes exist on every content slide.

## Step 5 — Verify — render every slide to PNG and look

This step is not optional. Decks break in obvious ways that code review won't catch:

- title wraps to 2 lines, accent element stranded between lines
- subtitle overlaps body content
- short text columns under a wide block look empty
- Russian / Cyrillic text is wider than Latin and overflows
- accent color from preset A bleeds into preset B's slides
- bullet markers (•) disappear or appear as `o`

**Completion criterion:** every slide has a `slide-NN.png` in `slides-png/`, every PNG has been opened with `read`, and you have written `verification.md` listing each slide as PASS / FIX / PASS-AFTER-FIX.

Full per-preset and per-slide defect checklist lives in [`verification-checklist.md`](verification-checklist.md).

## Step 6 — Fix and re-verify

For each FIX item, patch `build-pptx.js` and rerun step 5. Common root causes:
- detached accent element + multi-line title → switch to a left-border bar that grows with the title block
- text overflowing column → shorten copy or set `wrap: true` with `fit: "shrink"`
- Cyrillic characters wider than Latin → reduce font size by ~15% or split into two lines
- footer overlapping body → footer at y=7.15, body content capped at y=6.8
- bullet markers invisible → use `bullet: true` per item, not `bullet: { type: "bullet" }` with `\n`
- preset A bleeding into preset B → check `build-pptx.js` doesn't import constants from another preset

**Completion criterion:** every slide is PASS in `verification.md` after at most two re-renders. If a slide needs three, the structure is wrong — redesign that slide from scratch.

## Stack (fixed)

| Purpose | Tool |
|---|---|
| Generate PPTX | [`pptxgenjs`](https://github.com/gitbrent/PptxGenJS) |
| Render PPTX → PDF | LibreOffice headless: `soffice --headless --convert-to pdf deck.pptx` |
| Render PDF → PNG | `pdftoppm -png -r 110 deck.pdf slide` |
| Inspect PNGs | Open each `slide-NN.png` directly with `read` — no browser or HTTP server needed |

Install once on Linux: `apt-get install -y --no-install-recommends libreoffice-impress libreoffice-core poppler-utils`. On Mac: `soffice` is native, `brew install poppler` for `pdftoppm`.

## Anti-patterns

- **Skipping the verify pass.** Code that compiles is not a render that works. Every deck shipped the first time has at least 2 broken slides.
- **Inventing traction.** A placeholder `[—]` is honest; "10k MAU" with no source is a red flag anyone can verify in 30 seconds.
- **Feature-list opening.** Slide 2 is not "what our product does" — it's "what pain you have and why we solve it differently".
- **Mixing style presets slide-by-slide.** Pick one preset for the whole deck. Mixing `minimal` typography with `bold` color blocks looks like clip art.
- **Two accent colors.** Each preset ships exactly one accent. Adding a second is a 2008 PowerPoint tell.
- **Generic claims.** "Best-in-class" and "seamless" say nothing. Replace with the specific differentiator you have, even if it's narrower.
- **Long Russian titles.** Cyrillic is wider than Latin. If a title hits 2 lines, either shorten it, reduce the font, or accept the 2-line wrap — but plan for it.

## Output contract

When the deck is done, you deliver these files in the working directory:

- `deck.pptx` — the main artifact
- `deck.pdf` — for previewing without PowerPoint
- `build-pptx.js` — the generator script (so the user can edit and rerun)
- `slides-png/` directory with one PNG per slide for quick scan
- `verification.md` — PASS / FIX log
- `spec.md` and `deck-spec.md` — the inputs the deck was built from

If the user wants a different filename (e.g. `eora-tech-deck.pptx`), use it. The contract is the file list, not the exact names.

## When to expand the system

If the user asks for a style the five presets don't cover (e.g. "make it look like Stripe", "do a vintage academic poster"), you have two options:

1. Pick the closest preset and customize the constants in `design-system.md`. Most "brand-specific" requests are 90% one of the existing presets with a different accent color and font.
2. Add a new preset to `design-system.md` — give it a name, a palette, a typography stack, and an accent treatment, then use it. Update the table in Step 1 so future runs can pick it.

Don't freelance inside a deck. If you change colors slide-by-slide, the deck looks assembled rather than designed.
