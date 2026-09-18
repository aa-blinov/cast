## Config, CI, and data files (YAML / JSON / TOML)

- Secrets, tokens, private hosts or credentials committed in plain text.
- A CI workflow that runs untrusted input with elevated permissions
  (`pull_request_target` plus a checkout of the PR head), or grants a token more
  scope than the job needs.
- A version or dependency pin loosened or removed, and lockfile/manifest pairs
  that disagree after this change.
- A changed default that silently alters behaviour for existing installs —
  timeouts, retries, limits, feature flags.
- Indentation and type mistakes that parse but mean something else: a string
  where a list was meant, `no`/`yes` read as booleans in YAML.
