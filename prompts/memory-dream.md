# Dream: Memory Consolidation

Consolidate durable project memory from the supplied project trajectory and memory files.

Review the last seven days, or all available history if shorter. The raw trajectory is authoritative; MEMORY.md, checkpoint.md, notes.md, and task progress are structured indexes. Read the existing project MEMORY.md and recent session memory before editing. Verify candidate facts against the trajectory. Promote only explicit user rules, clear design decisions, repeated evidence, stable gotchas, and fixes whose cause is known.

Use the file tools to update the project MEMORY.md in place. Keep it compact and high-signal. Merge duplicates, remove stale entries only when the evidence supports it, preserve useful section structure, and keep entries to one or three lines. Do not create skills, personas, commands, or other workflow artifacts; that belongs to /distill.

Do not modify SQLite session history, source files, or files outside the resolved memory/project paths. Return a short maintenance summary after the file edits.

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
