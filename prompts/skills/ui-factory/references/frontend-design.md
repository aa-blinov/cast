# Frontend design — borrowed from anthropics/claude-code `frontend-design`

> Source: `plugins/frontend-design/skills/frontend-design/SKILL.md` (anthropics/claude-code, 1.1.0). Condensed for ui-factory fabric — thesis + type + structure + motion + writing.

Approach as the design lead at a small studio: every client gets a visual identity that could not be mistaken for anyone else's. Client rejected templated proposals — make deliberate, opinionated palette/type/layout choices specific to *this* brief, take one justified aesthetic risk.

## Ground it in the subject
If brief is vague, pin it: name one concrete subject, its audience, single job. Use any memory of user's taste. Subject's own world (materials, instruments, vernacular) is where distinctive choices come from. Build with real content throughout.

## Design principles
- **Hero is a thesis.** Open with the most characteristic thing (headline, image, live demo, interactive moment). `big number + small label + gradient accent` is the template answer — use only if truly best.
- **Typography carries personality.** Pair display + body deliberately (not same family for every project). Distinctive choices: `Playfair Display/Crimson Pro` editorial, `IBM Plex/Source Sans 3` technical, `Bricolage Grotesque/Newsreader/JetBrains Mono/Fira Code` distinctive. Contrast = interesting (display+monospace, serif+geometric). Use extremes 100/200 vs 800/900, size jumps 3×+. One distinctive font, decisively, load from Google Fonts.
- **Structure is information.** Numbering/eyebrows/dividers/labels must encode truth; `01/02/03` only for a real sequence/timeline where order matters. Question every marker before adding.
- **Leverage motion deliberately.** Page-load sequence, scroll-reveal, hover micro, ambient atmosphere — one orchestrated moment > scattered effects. Less is often more (extra animation = "AI-generated" feel). Respect `prefers-reduced-motion`.
- **Match complexity to vision.** Maximalist = elaborate execution; minimal = precision in spacing/type/detail. Elegance is executing the chosen vision well.
- **Words are material.** Name by what people control ("notifications" not "webhook config"), specific > clever, active voice ("Save changes" not "Submit"), consistent vocabulary, plain sentence case, errors/empty states give direction not apology.

## Process
1. **Brainstorm plan** (in thinking): Color 4–6 named hex, Type 2+ roles (display restrained + body + utility data/caption), Layout one-sentence + ASCII wireframe, Signature — the one remembered element.
2. **Review uniqueness:** if any part reads like the generic default you'd produce for *any* similar prompt (cream `#F4F1EA`+serif terracotta / near-black+acid green / broadsheet hairlines) — revise, state why.
3. **Build exactly to plan**, deriving every color/type from it. Watch CSS specificity (`.section` vs `.cta`).
4. **Refine:** context pressure makes you unlearn just-applied principles. Re-apply, screenshot if possible, iterate. Spend boldness in one place, cut decoration that doesn't serve brief. Chanel rule: remove one accessory before shipping. Quality floor: responsive ≤768px, visible `:focus`, reduced-motion respected.

In ui-factory, this maps to: `LAYOUT/THEME` = plan, `style.css` = execution, signature = one risk (`ASCII banner`, brutalist rule, etc.).

See [anthropics blog](https://claude.com/blog/improving-frontend-design-through-skills) for full writeup.
