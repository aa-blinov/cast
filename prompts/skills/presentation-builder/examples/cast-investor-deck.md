# Example — what a finished deck looks like

This is the cast investor deck I built using this skill. Read it once to internalize the output shape:

- `cast-investor-deck.pptx` — 12 slides, 16:9
- `cast-investor-deck.pdf` — preview without PowerPoint
- `slides-png/` — 12 PNG renders for inspection
- `build-pptx.js` — the generator script

## Structure of the cast deck

| # | Slide | One-line idea |
|---|---|---|
| 1 | Title | cast — Role-based terminal agent harness |
| 2 | Problem | LLM-агенты сильны в коде, но слабы в суждении |
| 3 | Insight | Роль — это не косметика (3 arxiv citations as cards) |
| 4 | Solution | 20 personas · same tools · different judgment (4 columns) |
| 5 | Demo | One repo · one run · three investigations (3 terminals) |
| 6 | Product surface | Personas · Skills · MCP · Rules · Sub-agents · Plan (2×3 grid) |
| 7 | Why now | Commoditization · On-prem · Agent sprawl (3 numbered waves) |
| 8 | Market | TAM table + SAM/SOM band |
| 9 | Business model | Free/OSS · Team · Enterprise (3 tier cards) |
| 10 | Traction | 6 metric cards — all `[—]` for honesty |
| 11 | Team | Founder cards + advisors + hiring band |
| 12 | The ask | Round · Use of funds · Milestones + contact CTA |

## What I had to fix in iteration 2

Defects caught in the verify pass:

1. Title wraps to 2 lines on slides 2, 3, 5, 8 → accent rule stranded mid-text → **switched to left-border bar**
2. "Runs where your code runs" wraps and accent line crashes into body → **shortened to "Runs anywhere"**
3. "Commoditization моделей" with no breathing room → **increased title h to 0.8, body y to 4.0**
4. "docs/eval-methodology.md" wraps to 3 lines, covers label → **shortened to "есть"**
5. Milestone "1. [X] stars / [Y] actives" wraps and covers milestones 2–4 → **split into value + numbered list**

All five caught by opening PNGs with `read`. None caught by reading build-pptx.js. This is why the verify pass exists.

## Output contract checklist

When you finish a deck, the working directory has:

- [ ] `deck.pptx` (or project-specific name)
- [ ] `deck.pdf` for preview
- [ ] `build-pptx.js` for editing
- [ ] `slides-png/` directory with N PNGs (one per slide)
- [ ] `verification.md` with PASS / FIX for every slide
- [ ] Speaker notes in the .pptx for every content slide (view in PowerPoint via View → Notes)