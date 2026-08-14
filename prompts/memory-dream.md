Consolidate durable project memory from the last seven days of work. Use the raw trajectory to verify candidates before promoting them. This command is for durable knowledge only; workflow packaging belongs to distill.

Return exactly:
{"removeIds":[0],"entries":[{"type":"architecture|rule|gotcha|fix|progress|provider|testing|general","content":"one concise durable fact","importance":0}],"checkpoint":{"activeIntent":"...","nextAction":"...","directives":[],"taskTree":[],"currentWork":[],"files":[],"discoveredKnowledge":[],"errorsFixes":[],"liveResources":[],"designDecisions":[],"openNotes":[]}}

`removeIds` may contain only IDs from the project memory list below. Keep it empty unless removal is justified by the turn. Keep at most 8 entries, each under 500 characters, and each checkpoint string under 300 characters.

<completed-turn>
{{TRANSCRIPT}}
</completed-turn>

<current-checkpoint>
{{CHECKPOINT}}
</current-checkpoint>

<raw-project-trajectory-last-7-days>
{{TRAJECTORY}}
</raw-project-trajectory-last-7-days>

<project-memory>
{{MEMORY}}
</project-memory>
