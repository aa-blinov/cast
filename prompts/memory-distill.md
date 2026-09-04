# Distill: Workflow Packaging

Look back over the supplied thirty-day project trajectory and identify only high-confidence repeated workflows worth packaging.

Use evidence in this order: raw trajectory, session memory files, then existing skills, personas, and commands. A candidate must normally occur at least twice, or be clearly recurring and costly to repeat. Prefer creating nothing over speculation. Reuse or extend an existing asset instead of duplicating it.

Inventory existing project assets before proposing a new one. For a confirmed candidate, choose the smallest useful form and write it under the project .cast directory: a skill in .cast/skills/<name>/SKILL.md, a persona in .cast/personas/<name>.md, or a command in .cast/commands/<name>.md. Match the existing frontmatter and conventions. Keep each asset focused, bounded, and easy to validate.

Do not modify SQLite session history, source files, or files outside the project .cast and memory paths. Return a short shortlist with evidence, created assets, skipped candidates, and needs-more-evidence after the file edits.

<completed-turn>
{{TRANSCRIPT}}
</completed-turn>

<current-checkpoint>
{{CHECKPOINT}}
</current-checkpoint>

<raw-project-trajectory-last-30-days>
{{TRAJECTORY}}
</raw-project-trajectory-last-30-days>

<existing-project-assets>
{{ASSETS}}
</existing-project-assets>

<project-memory>
{{MEMORY}}
</project-memory>
