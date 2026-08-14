Distill reusable workflows from the verified project trajectory. Use the thirty-day trajectory, checkpoint, project memory, and completed turn below. Do not package a one-off action. Do not duplicate an existing skill, subagent, or command.

Return exactly:
{"artifacts":[{"kind":"skill|subagent|command","name":"short-name","description":"what it does","content":"complete reusable instructions"}]}

Return at most 4 artifacts. Each name must be short and stable, each description under 240 characters, and each content under 4000 characters. Only include a workflow supported by the turn and project context.

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
