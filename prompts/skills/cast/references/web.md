Use `cast web` to start the browser UI. With no public bind it is for the local machine; `cast web --port 1337 --public` binds to the network and requires the configured login password. The web login uses an HttpOnly, SameSite cookie and its sessions survive a server restart, but plain HTTP does not encrypt the password or conversation.

For remote use without a domain and TLS, prefer an SSH tunnel instead of exposing the port:

```bash
ssh -L 1337:127.0.0.1:1337 user@server
```

Then open `http://localhost:1337` locally. Do not claim that a password makes public HTTP safe against a network observer. Use HTTPS through a trusted reverse proxy or tunnel before exposing Cast to an untrusted network.

Web settings configure the same global providers, models, skills, MCP servers, plugins, hooks, SSH hosts, theme, and fonts as the TUI. Editing files under `.cast/` or `~/.cast/` still requires `/reload` in an active session; toggles and installs made in Settings apply immediately.
