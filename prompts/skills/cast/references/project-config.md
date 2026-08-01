Project-local configuration lives in `<project>/.cast/` and is deliberately trust-gated: Cast does not load project skills, rules, MCP servers, personas, or hooks until the project is trusted. Global configuration in `~/.cast/` is always active.

Common project layout:

```
.cast/
  mcp.json
  hooks.json
  personas/
  rules/
  skills/<name>/SKILL.md
```

Use project-local configuration for repository-specific instructions and integrations that collaborators should share. Keep credentials out of it: use provider settings, environment variables, or a local untracked file. After adding or editing project files, run `/reload`; it rescans configuration without clearing the conversation.

Whether `.cast/` belongs in git is a repository decision. Commit safe, reproducible configuration such as rules, skills, and hook definitions. Ignore machine-specific state and secrets, including API keys, generated session data, and private MCP headers. Before enabling a project hook or MCP server, inspect its command, environment, and source because it can execute code or expose local data.
