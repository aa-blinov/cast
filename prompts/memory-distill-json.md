# Distill: Workflow Packaging (JSON)

Review the supplied thirty-day project trajectory and the existing assets, then return a single JSON object listing only high-confidence repeated workflows worth packaging.

A candidate must normally occur at least twice, or be clearly recurring and costly to repeat. Reuse or extend an existing asset instead of duplicating it; prefer creating nothing over speculation. You are producing JSON for the caller to materialize; you have no file tools.

Return exactly this JSON shape and nothing else:

{"artifacts":[{"kind":"skill","name":"isolated-tests","description":"one-line purpose","content":"full reusable body"}]}

Rules:
- `kind` is one of `skill`, `subagent`, or `command`.
- `name` is a short slug (lowercase, dashes, underscores).
- `description` is a one-line purpose under 240 characters.
- `content` is the full reusable instructions or body, under 4000 characters.
- Return at most 4 artifacts; use an empty array when nothing qualifies.
- Return one JSON object and nothing else — no markdown fences, no prose.

<project-memory>
{{MEMORY}}
</project-memory>

<raw-project-trajectory-last-30-days>
{{TRAJECTORY}}
</raw-project-trajectory-last-30-days>

<existing-project-assets>
{{ASSETS}}
</existing-project-assets>

<current-checkpoint>
{{CHECKPOINT}}
</current-checkpoint>

<completed-turn>
{{TRANSCRIPT}}
</completed-turn>
