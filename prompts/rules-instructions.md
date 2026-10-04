The following rules provide project-specific guidance.
Use the read tool to load a rule's file when the task matches its description.
When a rule file references a relative path, resolve it against the rule directory (the directory containing the file) and use that absolute path in tool commands.
Rules that always apply, and rules tied to files by globs once such a file is in context, are already part of this prompt: do not read them again.
Mention a rule by typing `@rule-name` in your message to inject it manually.
