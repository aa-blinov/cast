# Dream: Memory Consolidation (JSON)

Consolidate durable project knowledge from the supplied project memory and the recent trajectory, then return a single JSON object.

Keep only facts supported by the evidence:
- architecture decisions and their rationale;
- stable project rules explicitly stated by the user;
- verified gotchas and fixes whose cause is known;
- cross-session durable knowledge.

Do not invent facts, preferences, or workflows. Remove stale or contradicted entries only when the evidence supports it. You are producing JSON for the caller to apply; you have no file tools.

Return exactly this JSON shape and nothing else:

{"removeIds":[1,2],"entries":[{"type":"rule","content":"one concise durable fact","importance":80,"confidence":70,"expiresAt":"optional ISO-8601 timestamp","supersedes":[]}],"checkpoint":{"activeIntent":"...","nextAction":"...","directives":[],"taskTree":[],"currentWork":[],"files":[],"discoveredKnowledge":[],"errorsFixes":[],"liveResources":[],"designDecisions":[],"openNotes":[]}}

Rules:
- `removeIds` must reference ids shown in <project-memory>; remove only entries the evidence supports removing.
- `type` is a short label such as `rule`, `decision`, `gotcha`, `fix`, or `knowledge`.
- `importance` and `confidence` are integers from 0 to 100.
- Keep each `content` under 500 characters and return at most 8 entries.
- Use an empty array/object when nothing is supported.
- Return one JSON object and nothing else — no markdown fences, no prose.

<previous-checkpoint>
{{CHECKPOINT}}
</previous-checkpoint>

<project-memory>
{{MEMORY}}
</project-memory>

<raw-project-trajectory-last-7-days>
{{TRAJECTORY}}
</raw-project-trajectory-last-7-days>

<completed-turn>
{{TRANSCRIPT}}
</completed-turn>
