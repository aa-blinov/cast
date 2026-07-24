# cast — Product Assessment & Growth Strategy

## Executive Summary

**cast** is a role-based terminal agent harness — think Claude Code's power, but provider-agnostic, persona-driven, and self-hosted. At v0.8.14 with ~300 commits, 23k lines of TypeScript, and a rich feature set (18 personas, Web UI, plan mode, sub-agents, plugin marketplace, eval framework), it's a technically mature project at a critical inflection point: the core product is strong, but visibility and distribution are the bottlenecks.

**Bottom line**: cast is built for developers who want Claude Code's capabilities without vendor lock-in. The product-market fit exists; the challenge is reaching the right audience before better-funded competitors close the gap.

---

## 1. Product Assessment

### What works (strengths)

| Area | Why it matters |
|------|---------------|
| **Provider-agnostic** | Works with Ollama, vLLM, OpenRouter, any OpenAI-compatible API. This is cast's #1 differentiator. In a market where Claude Code = Anthropic, Copilot = GitHub/OpenAI, cast is the "bring your own model" option. |
| **Persona system** | 18 built-in personas (coding, QA, PM, DBA, SRE, devops, etc.) that swap judgment without changing tools. No competitor does this at this depth. It turns one product into 18 tools. |
| **Local-first, no telemetry** | Resonates with privacy-conscious devs, regulated industries, and the air-gapped/defense sector. A real moat in an era of "everything phones home." |
| **Plan mode** | Read-only exploration → approval → build. This "think before you build" flow is genuinely differentiated — most agents go straight to editing. |
| **Plugin marketplace** | Compatible with Claude/Grok/Codex catalogs. Network effects potential: every community skill pack makes cast more valuable. |
| **Web UI** | `cast web` gives a browser-based control room. Enables team sharing, remote access, and scenarios where TUI isn't practical. |
| **Eval framework** | `evals/` with mutation benchmarks, format-tolerant grading, and model-vs-harness separation is rare at this level of rigor. This is a developer tool for people who care about how tools work, not just that they work. |
| **Self-contained bundle** | No npm at runtime. `curl | bash` installs a single file. This is how CLI tools should ship. |

### What's missing (weaknesses / gaps)

| Gap | Impact | Severity |
|-----|--------|----------|
| **No GitHub presence / brand** | Zero stars, no community, no organic discovery. The repo is `aa-blinov/cast` — no landing page, no Product Hunt, no Hacker News thread. | Critical |
| **No team/collaboration features** | Sessions are local-only. No shared context, no team workspaces, no "see what your colleague's agent did." This limits adoption in any org >1 person. | High |
| **No CI/CD integration story** | `cast run` exists but there's no GitHub Action, no GitLab CI template, no documented workflow for "run cast on every PR." | High |
| **Documentation is solid but undiscoverable** | 19 doc pages, well-written, but hosted on GitHub Pages with no SEO, no search, no tutorial funnel. | Medium |
| **No pricing / business model** | It's MIT-licensed and free. No SaaS tier, no hosted offering, no "premium features." This is fine for now but limits sustainability. | Medium |
| **No onboarding beyond first-run** | The first-run flow is good, but there's no "here's what you can do" tutorial, no example workflows, no "try these 5 things" guide. | Medium |
| **No telemetry = no product data** | You can't improve what you can't measure. No usage analytics means decisions are based on gut, not data. | Medium |
| **Windows support is secondary** | Git Bash / msys2 requirement. Not a first-class experience. | Low |

### What could kill it (threats)

1. **Anthropic ships personas into Claude Code.** If Claude Code adds role-switching or agent profiles, cast's biggest differentiator erodes. Mitigation: cast's advantage is provider-agnostic + self-hosted — Claude Code can't easily copy that without undermining its own business model.

2. **A well-funded competitor (Cline, Continue, Roo) adds provider-agnostic + personas.** Open-source competitors are moving fast. The window to establish cast as the default is 6-12 months.

3. **Model quality makes harness quality irrelevant.** If models get good enough that any harness works, the harness becomes a commodity. Mitigation: the persona system and workflow features (plan mode, sub-agents) add value beyond raw coding.

4. **Burnout.** This appears to be a solo/very small team project. Sustainability is a real risk.

---

## 2. Positioning

### Current (implicit)
"A role-based terminal agent harness" — accurate but doesn't sell.

### Recommended
**"The Claude Code alternative that works with any model."**

More specifically: cast is for developers who want the power of terminal coding agents but refuse to be locked into one model provider. The persona system makes it the Swiss Army knife of AI coding — one tool, many expert modes.

### Positioning matrix

| | IDE-integrated | Terminal-native |
|---|---|---|
| **Single provider** | Cursor, Copilot | Claude Code, Aider |
| **Any provider** | Continue, Cline | **cast** |

cast owns the bottom-right quadrant. That's a real, defensible position.

---

## 3. Go-to-Market Strategy

### Phase 1: Establish Visibility (Weeks 1-4)

**Goal**: Go from 0 to 100 GitHub stars. Get 500 unique installs.

| Action | Why | Effort |
|--------|-----|--------|
| **Hacker News "Show HN" post** | The single highest-ROI distribution channel for developer tools. Title: "Show HN: cast — a terminal coding agent that works with any model, not just Claude" | 1 day |
| **Product Hunt launch** | Secondary distribution, but builds brand. Schedule for Tuesday/Wednesday. | 1 day |
| **README rewrite** | Lead with the value prop, not the feature list. Before/after GIF showing cast vs Claude Code on the same task with different models. | 2 days |
| **Twitter/X thread** | "I built a Claude Code alternative. Here's why: [provider agnosticism story]. It supports 18 personas. Here's a demo:" — attach a 60-second terminal recording. | 1 day |
| **Dev.to / Medium article** | "Why I built cast: the terminal coding agent that doesn't lock you into Claude" — longer-form, SEO-optimized. | 2 days |

### Phase 2: Build Community (Weeks 2-8)

**Goal**: 500 GitHub stars. 50 active users. First community contributions.

| Action | Why |
|--------|-----|
| **Discord server** | Low-friction community space. Pin a "getting started" channel and a "show and tell" channel. |
| **Contribution-friendly issues** | Tag 20 issues as `good first issue`. Write clear specs. Respond to PRs within 24 hours. |
| **Weekly changelog email** | Use a simple mailing list (Buttondown, Mailchimp). Every release gets a 3-sentence summary + link. |
| **"Powered by cast" badge** | Small script in the docs site that shows install count. Social proof compounds. |
| **Partner with model providers** | OpenRouter, Ollama, vLLM teams have an incentive to promote tools that drive usage. Reach out for co-promotion. |

### Phase 3: Enterprise & Monetization (Months 2-6)

**Goal**: First paying customer. Sustainable revenue.

| Approach | Details |
|----------|---------|
| **cast Cloud (hosted)** | A managed version: no install, browser-based, team workspaces, SSO, audit logs. Think "Vercel for coding agents." Price: $20-50/user/month. |
| **Enterprise license** | Self-hosted with support SLA, custom personas, priority features. Price: custom. |
| **Marketplace take rate** | If the plugin marketplace grows, a 10-20% take rate on paid plugins is standard (see VS Code marketplace, Figma community). |
| **Consulting / integration** | For the first 6-12 months, direct consulting for enterprise adopters is the fastest path to revenue while the product matures. |

### Pricing strategy

| Tier | Price | Target |
|------|-------|--------|
| **Free (self-hosted)** | $0 | Individual developers, open-source users |
| **cast Cloud** | $20/user/mo | Small teams, startups |
| **Enterprise** | Custom | Regulated industries, large orgs |
| **Marketplace** | 15% take | Plugin creators |

---

## 4. Feature Roadmap (Next 6 Months)

### Must-have (Q3 2026)

1. **Team workspaces** — shared sessions, shared rules, shared personas. Without this, cast is a solo tool.
2. **GitHub Action** — `uses: cast/cast-action@v1` that runs cast on PRs, posts comments with suggestions. This is the CI/CD integration story.
3. **Landing page** — a real website (not just GitHub Pages docs). Hero section, 3 use cases, install command, social proof.
4. **Usage analytics (opt-in)** — anonymous, GDPR-compliant telemetry. You need data to make product decisions. Make opt-in transparent and easy to disable.

### Should-have (Q4 2026)

5. **Persistent memory across sessions** — "Remember that we use zod for validation" type context that survives compaction.
6. **Multi-file refactor workflow** — a guided "I want to refactor X into Y" flow with preview, confirm, and rollback.
7. **Cost tracking dashboard** — show per-session and per-model token usage and estimated costs. Users who bring their own API keys care deeply about this.
8. **Custom persona marketplace** — let users publish and install personas, not just skills.

### Nice-to-have (2027)

9. **VS Code extension** — not a full IDE integration, but a sidebar that shows cast's session, allows sending context from the editor. "Terminal agent + editor companion."
10. **Mobile companion** — view sessions, approve plans, send quick prompts from your phone. Not for coding, for oversight.
11. **SOC 2 compliance** — for enterprise sales, this is table stakes.

---

## 5. Key Metrics to Track

### North star
**Weekly active sessions** — unique users who complete at least one agent interaction per week.

### Supporting metrics

| Metric | Why | Current (estimate) | Target (6mo) |
|--------|-----|---------------------|---------------|
| GitHub stars | Discovery, social proof | ~0 | 2,000 |
| Weekly installs | Distribution | Unknown | 500 |
| Week-2 retention | Product stickiness | Unknown | 40% |
| Personas used per session | Feature engagement | Unknown | >1.5 avg |
| Sessions using plan mode | Feature adoption of differentiator | Unknown | 20% |
| NPS | Satisfaction | Unknown | >50 |
| Time to first successful edit | Onboarding quality | Unknown | <3 min |

### How to measure without telemetry
- `cast run --format json` → pipe to a lightweight endpoint (opt-in)
- GitHub stars / forks / issues as proxy for awareness
- Discord member count + active conversations as proxy for community
- Survey after 7 days of usage (in-app prompt)

---

## 6. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Anthropic adds personas to Claude Code | Medium | High | Move fast on provider-agnostic + self-hosted positioning. Claude Code can't copy this without undermining its own model-lock business. |
| Solo developer burnout | High | Critical | Consider co-founder or early hire. Open-source contributions can distribute load. |
| No monetization path | Medium | High | Start with cast Cloud (hosted) as the simplest revenue path. Don't overcomplicate. |
| Plugin marketplace doesn't get traction | Medium | Medium | Seed it yourself. Create 20 high-quality skill packs across common use cases (Docker, AWS, React, etc.). |
| Model quality leap makes harness irrelevant | Low | Medium | The persona system and workflow features (plan mode, sub-agents, team features) add value beyond raw coding. |

---

## 7. Competitive Differentiation Summary

| Feature | cast | Claude Code | Aider | Cursor | Cline |
|---------|------|------------|-------|--------|-------|
| Provider-agnostic | Yes | No (Anthropic only) | Yes | Partial | Yes |
| Personas (18+) | Yes | No | No | No | No |
| Plan mode | Yes | No | No | No | No |
| Sub-agents | Yes | Yes | No | No | No |
| Web UI | Yes | No | No | No | No |
| Plugin marketplace | Yes | Yes | No | No | No |
| Self-hosted | Yes | No | Yes | No | Yes |
| No telemetry | Yes | No | Yes | No | Yes |
| Eval framework | Yes | No | No | No | No |

cast has the broadest feature set in the terminal agent category. The risk is being a "jack of all trades" — but in a market where users are choosing between tools that each do 3-4 things well, being the tool that does everything is actually the right bet.

---

## 8. Immediate Next Steps (This Week)

1. **Write the Hacker News post.** 500 words, lead with the problem ("I was tired of being locked into Claude for my coding agent"), show a demo GIF, link to the repo. Post on Tuesday 9-11am ET.

2. **Record a 60-second terminal demo.** Show cast using Ollama locally on the same task that Claude Code would use Claude for. The "runs on your own hardware" story is visceral.

3. **Rewrite the first 20 lines of README.** Currently leads with ASCII art and "A role-based terminal agent harness." Should lead with "The Claude Code alternative that works with any model — including the one on your laptop."

4. **Create a GitHub repo badge** showing install count. Social proof from day one.

5. **Set up a Discord server.** Link in README. Even if it's just you for the first month, the structure signals "this is a real project with a community."

---

*Assessment date: 2026-07-23*
*Product version: 0.8.14*
*Lines of code: ~23,000 TypeScript*
*Commits: ~300*
