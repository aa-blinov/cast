# The web UI: map and decisions

The browser client (`cast server`) is one page with a few surfaces around a conversation. This page is the map: where things are, how they move between a desktop and a phone, and the rules the layout follows. It is for people changing the client; for using it, see [the server docs](api.md).

## Surfaces

```
header      sessions panel toggle . connection dot . [status] [dashboard] [settings] [shortcuts] [files panel toggle]
sidebar     new session . quick session . search . sessions grouped by date . model . log out
chat        the thread: user, reasoning (folded), tool cards, agent text, turn meta
composer    role line (persona, mode, folder, timer) . queued messages . input . attach . voice . send
files panel inputs . files . memory . changes (diff)
full pages  /dashboard . /settings (routes, not modals: back button and reload work)
modals      new session . share . shortcuts . command palette (type / in the composer)
```

## Flows

| Goal | Path |
| --- | --- |
| Start work in a folder | New session, pick persona and folder (or sandbox), type |
| Ask something throwaway | Quick session (bolt button): sandbox folder, assistant persona |
| Go back to earlier work | Sidebar row, or search; rows show title, folder and age |
| Steer a running turn | Type while it runs: the message is queued or steers, shown above the input |
| See what changed | Files panel, Changes tab; per-message fork and rewind |
| Hand a session to someone | Share, a read-only live link |
| Change how it behaves | Settings (model, persona, reasoning, appearance, memory, MCP) |

## Responsive rules

- At 768px and below the sessions panel and the files panel become full-width overlays; only one is open at a time.
- The shortcuts button is hidden in portrait on a phone (a physical-keyboard feature). The dashboard stays: its header wraps and its charts scroll.
- Under a coarse pointer every stand-alone control grows to a 44px target; small ones (pin, more, copy) keep their look and grow their hit area.
- Inputs are 16px on iOS so focusing a field does not zoom the page.
- No horizontal page scroll at any width; long paths and code scroll inside their own box.

## Decisions

- **A session row says what it is.** An untitled session is "New session" while it is empty, and every row carries the folder and its age. A persona name alone was the same on every row.
- **Unused sessions are hidden.** A session with no messages stays out of the list unless it is open, pinned or running, so clicking New session and leaving does not leave a trail.
- **Finished reasoning folds to one line.** It stays one tap away; while it streams it is open. A reply with several tool calls otherwise spends most of a phone screen on boxes of thought.
- **The role line says "sandbox", not a path.** The full path is in its tooltip.
- **The new-session dialog is one screen on a phone.** Persona cards put name and source on one row.
- **The two panel buttons look like the panels.** Both were chevrons pointing opposite ways; they are now a window with a left or right bar, so it is clear which panel each opens.
- **Settings opens on its current tab,** not on "Reload resources", whose tooltip covered the tab row.
- **Signing in returns to where you were going.** A link to a session, or an expired login mid-session, goes to `/login?next=...` and comes back; `next` is accepted only as a path on this site.
- **Losing the server is visible and recovers by itself:** the dot turns yellow, the composer reads "Reconnecting..." and is disabled, and it returns without a reload.
