# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal

(The schema's values are web, ios, android and adaptive; none fits. The surface in question is the full-screen TUI in `src/ui-pi`, drawn in a character grid. The browser UI in `src/server/public` is a separate surface.)

## Users

Developers in long working sessions: hours in a terminal, locally and over ssh/tmux, with the screen next to an editor. They read a lot of text and code, switch personas, and run turns that take seconds to minutes. Terminal themes, colour depth and window sizes vary (confirmed by the owner for the TUI's primary user; team and other-audience details are not recorded).

## Product Purpose

cast is a coding agent for the terminal (and a browser UI): a loop that reads, edits and runs things in a repository, with sessions, memory, skills and MCP. The TUI is where the work is watched and steered.

## Positioning

Personas and a lazy senior: one engine, an agent with a character chosen for the task (Senior Developer, Planner, Reviewer, …), whose defaults are root-cause fixes and deletion over addition. Confirmed by the owner as the thing neighbouring agents cannot honestly copy.

## Operating Context

Alternate-screen TUI on pi-tui with app-owned scrolling; the conversation, a composer, a one-row status bar, and modal overlays (pickers, settings, status-bar editor, live subagent view). Works at 40 to 200+ columns. Daemon or local mode behind the same screen.

## Capabilities and Constraints

- Every rendered line must fit the width; no raw writes between frames.
- Colour depth varies (truecolor, 256, none); `NO_COLOR` is honoured.
- Text colours are held to 4.5:1 contrast against the background they sit on.
- Copy: short, dry, no emoji.

## Brand Commitments

None carried over: the owner said the current look (palette, gradients, rails, labels) may change freely. The name `cast` and the dry, short voice of the copy are the only constants in the code.

## Evidence on Hand

Real screens exist (tmux captures of the transcript, settings, pickers, status bar). No user testimonials, benchmarks or research recorded; none should be invented.

## Product Principles

1. Legibility over ornament: the reader spends hours on this screen.
2. The agent's character shows in behaviour and wording, not in decoration.
3. Quiet by default: colour and emphasis mark state and role, nothing else.
4. Works everywhere: width, colour depth and terminal quirks degrade gracefully.

## Accessibility & Inclusion

Contrast floor of 4.5:1 for text, meaning never carried by colour alone (shape or word as well), `NO_COLOR` support, keyboard-only operation.
