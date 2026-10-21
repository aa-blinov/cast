# API v1

Cast exposes a stable local integration API at `/api/v1`. Its OpenAPI 3.1
document is served by every daemon at:

```text
GET /api/v1/openapi.json
```

The same specification is published as a versioned snapshot on this site:
[OpenAPI v1 JSON](openapi/v1.json). It is generated from the exact object the
daemon serves and validated during tests, so it is suitable for inspection,
code generation, and CI validation.

## Why this API exists

The bundled TUI and web application are Cast clients, not the only way to use
a daemon. API v1 lets another trusted local client integrate with the same
long-running agent without scraping a terminal or depending on private web UI
routes. Typical uses include an IDE integration, automation that creates and
observes sessions, a focused dashboard, or a client implemented in another
language.

It deliberately exposes the daemon's durable boundaries: session lifecycle,
turn control, SSE events, files and attachments, and user-selected settings.
It does not turn the browser login flow or public share page into integration
resources; those are browser transport features.

Use that document for generated clients, validation, and endpoint details. The
stable API covers every daemon capability needed by an alternative client:
session lifecycle and metadata, agent-turn control, history and SSE,
attachments, filesystem and directory browsing, Git state/diffs, personas,
models, reasoning, settings, provider verification, and SSH configuration.
Browser login pages and public shared-session HTML remain web transport/UI,
not agent API resources.

## Compatibility policy

- The URL major version is the compatibility boundary. `/api/v1` keeps its
  existing paths, request fields, response fields, and SSE event meanings for
  the lifetime of v1.
- Additive fields and endpoints are allowed in v1. Clients must ignore fields
  they do not recognize.
- A breaking change ships under a new major path such as `/api/v2`; v1 stays
  available during its documented deprecation window.
- Every v1 response includes `Cast-API-Version: 1`.
- Existing unversioned `/api/*` routes remain for Cast's bundled TUI/Web
  clients. They are compatibility aliases, not the supported integration
  contract; new integrations should use `/api/v1/*` only.

## Authentication

The API uses the daemon's existing auth boundary:

- A local client may send `Authorization: Bearer <token>`, using the token in
  `~/.cast/server.json`. The daemon deliberately accepts this only over a
  loopback connection.
- A browser or reverse-proxy client uses the `cast_web_session` HttpOnly
  cookie established by the normal sign-in flow.

Do not expose a daemon directly to an untrusted network. For remote access,
use a reverse proxy with HTTPS and browser authentication, or an SSH tunnel.

## Minimal example

```bash
# TOKEN is read locally from ~/.cast/server.json; never send it to a remote host.
curl -sS http://127.0.0.1:1337/api/v1/openapi.json | jq '.info'

curl -sS http://127.0.0.1:1337/api/v1/sessions \
  -H "Authorization: Bearer $TOKEN"
```

To start a turn, `POST /api/v1/sessions/{id}/chat`, then consume
`GET /api/v1/sessions/{id}/events` as `text/event-stream`. The OpenAPI
document defines the request body, accepted response statuses, and event
shape.
