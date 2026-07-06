The following rules provide project-specific guidance.
Use the read tool to load a rule's file when the task matches its description.
When a rule file references a relative path, resolve it against the rule directory (the directory containing the file) and use that absolute path in tool commands.
Rules with `alwaysApply: true` and `globs` are auto-injected when matching files enter context.
Mention a rule by typing `@rule-name` in your message to inject it manually.
