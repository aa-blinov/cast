# Personas in Agent Harnesses: Evidence, Boundaries, and Design

## Summary

A persona is a system-prompt configuration that gives an agent a role, priorities, and
operating rules. It can change what the model notices, how it frames a decision, and how
it uses tools. It does **not** add knowledge, make a model generally more capable, or
replace permissions, validation, and evaluation.

That distinction is a strength, not a weakness. Most valuable agent work is not a closed
factual question: it requires choosing what to inspect, which risks matter, when evidence
is sufficient, and what “done” means. A well-designed persona makes those choices
repeatable. In a harness, it also makes the active operating surface explicit: the same
switch can select the relevant tools, skills, MCP servers, and delegation roles.

The empirical record is mixed but useful:

- Role prompting can improve expert depth and some reasoning tasks, especially where the
  work requires judgment, prioritisation, or risk communication.
- It can reduce clarity or harm performance when the role is irrelevant, overly specific,
  or conflicts with the task.
- Direct evidence for tool-using agents is still limited. The clearest result is that a
  role plus explicit tool-use rules performs better than a role label alone.

For an agent harness, personas are therefore best treated as a **context and capability
profile**, not as a claim of expertise. They are a convenient way to switch the agent from,
for example, implementation work to a read-only review or research context, while changing
both its working instructions and the tools, skills, MCP servers, and subagent roles that
are actually available.

## The product thesis

Cast is built on two complementary, useful properties of personas:

1. **Specialised judgment.** A role gives the agent a stable decision frame. A QA persona
   can prioritise observable regressions and coverage; an appsec persona can prioritise
   trust boundaries and attack paths; an architect can prioritise interfaces and trade-offs.
   Research supports this kind of change in response characteristics, particularly on
   advisory and judgment-heavy work. It is the reason a role can produce a meaningfully
   different review of the same repository.
2. **Operational context switching.** A persona is a named, reusable harness profile. It
   can replace a long ad-hoc prompt and, when configured, expose only the tools, skills,
   MCP servers, and subagent roles appropriate to the current job. That makes a switch from
   implementation to review, research, or incident response explicit and enforceable.

The first property is probabilistic model steering; the second is deterministic harness
behaviour. Together they are stronger than either a generic “act as an expert” prompt or a
tool allowlist with no working method behind it.

## What research establishes

### Role prompts alter behaviour, not capability in general

In a controlled comparison over 1,140 open-ended questions, 38 expert roles, and six
domains, [Xiao et al.’s controlled study](https://arxiv.org/abs/2605.29420) found that
expert-role prompting increased measured expertise depth while reducing clarity. The effect
depended on the task and domain; it was strongest for advisory work and was not a general
performance improvement.

This is consistent with two complementary results:

- [Kong et al.](https://aclanthology.org/2024.naacl-long.228/) report that deliberately
  designed role-play prompts outperformed a standard zero-shot prompt on most of twelve
  reasoning benchmarks.
- [Zheng et al.](https://aclanthology.org/2024.findings-emnlp.888/) found no general
  benefit from system-prompt personas on 2,410 factual questions across four model families.

Together, these studies support a narrow claim: role framing is useful when it changes
judgment or process; it should not be expected to improve closed-form recall or every
reasoning task.

### The design of the role matters

Persona prompts are sensitive to irrelevant details. [An evaluation of nine models across 27
tasks](https://aclanthology.org/2025.emnlp-main.1364/) found expert personas usually had
positive or non-significant effects, but irrelevant persona attributes could reduce
performance by almost 30 percentage points. [Kim et al.](https://arxiv.org/abs/2408.08631)
likewise observed degraded reasoning in 7 of 12 datasets for some role-playing prompts.

The practical implication is straightforward: write a persona around responsibilities,
evidence standards, and completion criteria. Avoid theatrical backstory, demographic
simulation, or style-only instructions such as “sound senior”. Those details can introduce
uncontrolled changes without improving the work.

### Evidence specific to tool-using agents

The direct evidence base for agent harnesses is smaller than the evidence base for ordinary
chat prompting. Ruangtanusak et al. evaluated a tool-augmented role-playing agent and
compared basic role prompts with explicit rule-based role prompting. [Their best
condition](https://arxiv.org/abs/2509.00482), which paired the role with concrete rules for
when and how to call functions, scored 0.571 against 0.519 for the zero-shot baseline.

This does not establish that every coding agent improves from a persona. It does establish a
useful design principle: a role label is insufficient for reliable tool use; task-specific
instructions and an executable capability policy matter.

More broadly, tool-agent research finds that prompt and tool-description quality affect
selection and execution. [PLAY2PROMPT](https://aclanthology.org/2025.findings-acl.1347/),
for example, improves zero-shot tool use by deriving usage examples from tool interaction.
This supports keeping an agent's active tool context focused and well specified, but it is
not evidence that a persona alone improves tool use.

## Why personas are useful in a harness

### A single switch changes work context

An agent often moves between distinct jobs: implement a feature, investigate an incident,
review a change, write a migration, or prepare a release note. Each job needs a different
definition of useful work. A persona makes that context explicit and persistent for the
session rather than requiring the user to reconstruct a long instruction prompt every time.

In cast, a persona contains both a role prompt and optional capability policy. Switching it
can change:

| Layer | What changes |
|---|---|
| Judgment | Priorities, evidence to seek, and what counts as done |
| Built-in tools | `tools` allowlist, including read-only or write-capable actions |
| Skills | `skills` allowlist for model-invocable skill packages |
| MCP | `mcp` allowlist by server, so unrelated external tools are absent |
| Delegation | `subagents` and `subagentTypes` control whether and how work can be delegated |

This is the main engineering value of personas in a harness. The model sees a smaller,
task-relevant operating surface, while runtime enforcement ensures a disallowed tool is not
merely discouraged but unavailable. It is useful for least privilege, reducing accidental
tool selection, and keeping unrelated tool descriptions out of the active context.

This makes personas a product primitive rather than a prompt-library convenience: a user
can name and reuse the complete working context of an agent. The role tells the agent how
to reason about the job; the capability policy tells the harness which actions are in scope.

The claim has limits. A smaller prompt is not automatically a measured quality improvement
for every model or task, and a persona allowlist is not an operating-system sandbox. It
constrains calls through the cast agent loop; normal filesystem, process, network, and MCP
server permissions still determine what an allowed tool can do.

### Cast's built-ins favour workflow continuity

The shipped personas intentionally share the normal built-in, skill, and MCP surface, so a
role switch does not unexpectedly remove a workflow. `coder-with-subagents` additionally
enables `task`. Capability localisation is opt-in: define a custom persona with allowlists
when the task warrants it.

For example, a documentation-review persona can expose `read`, `grep`, `glob`, and selected
writing skills while excluding shell mutation and database MCP servers. An incident-review
persona can retain observability MCP servers but omit editing tools. These are harness
configuration choices, independent of whether role wording improves the underlying model.

## Implementation principles

1. **Treat the role as a procedure.** Specify the evidence to collect, risks to check,
   tool-use expectations, and completion criteria.
2. **Use runtime allowlists for real boundaries.** Prompt text is guidance; the `tools`,
   `skills`, `mcp`, and `subagentTypes` fields are enforced by the loop.
3. **Keep the active surface proportional to the job.** Exclude tools and MCP servers that
   are unrelated to the work, but do not remove a capability that the workflow requires.
4. **Start a new context when the job changes.** A mid-thread persona switch retains prior
   reasoning. Starting a new session is usually clearer when moving between unrelated
   responsibilities.
5. **Rebuild the system prompt on every model request.** Cast refreshes the first system
   message before each request, so the current persona and active context files remain in
   the system frame. This mitigates but does not eliminate long-context instruction decay.
6. **Measure the persona on the intended workflow.** Compare a neutral prompt, the current
   persona, and the proposed persona on the same model and cases. Track task success,
   invalid or unnecessary tool calls, latency, and human review quality.

Long-context evidence motivates the fifth principle: models use information in long prompts
non-uniformly and often perform worse when relevant information is in the middle of context,
as shown in [Lost in the Middle](https://arxiv.org/abs/2307.03172). Re-injection gives the
current system frame a stable position, but it is not immunity from context degradation.

## What cast does not claim

- A persona does not turn a general model into a certified security engineer, DBA, or
  incident commander.
- A persona does not provide a universal benchmark uplift.
- A role prompt is not a substitute for tool schemas, error messages, tests, hooks,
  permission checks, or outcome verification.
- A persona should not be used to simulate real demographic groups or to infer their views.
  That use has separate fidelity and bias problems.

Cast's behaviour scoreboard evaluates agent reliability. It is not a persona-effect study.
Demonstrating that a particular persona improves a workflow requires a separate ablation
with the same model, cases, tool policy, and scoring rule.

## Evidence quality and scope

The cited work mixes peer-reviewed conference papers, workshop papers, and arXiv preprints.
An arXiv URL alone does not establish peer review. Results are model-, task-, and prompt-
dependent; recent studies should be treated as evidence for design hypotheses and evaluated
against the actual harness, not as universal laws.
