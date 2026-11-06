# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - V2 upgrade

### Changed
- Port server and TUI entries to the OpenCode V2 plugin API.
- Generate suggestions without hidden sessions or conversation-history writes.
- Preserve worktree-root state and existing configuration, intent and steering formats.
- Run inference independently of event handling, with cancellation and serialised
  state mutations to prevent superseded results from reappearing.
- Pass execution outcomes directly into the recovery suggestion logic.
- Route terminal and Desktop state/configuration requests through session-scoped RPC.
- Keep disabled suggestions hidden and clear the current suggestion when disabling.
- Describe cache invalidation and automatic reseeding accurately.

### Added
- Desktop composer pill with safe Tab insertion, native Enter submission and Escape dismissal.
- Optional TUI prompt API patch for safe insertion and submission.
- Behavioural tests for lifecycle races, RPC routing and UI acceptance guards.
- CI typecheck, tests, build and committed Desktop bundle verification.

---

## [v0.1.3] - 2026-08-21

### Fixed
- Fixed ghost suggestions not rendering in the prompt box. The TUI previously toggled `showPlaceholder` off whenever a suggestion was ready and tried to force the placeholder through the renderer internals; it now uses the first-class `placeholders` prop (`{ normal: [text] }`) so the ghost renders natively and reliably.
- Removed the fragile `renderer.currentFocusedRenderable` mutation and the 100ms re-paint loop.

---

## [v0.1.2] - 2026-08-17

### Documentation
- Completely overhauled `README.md` following open-source documentation standards.
- Added TL;DR section with problem/solution breakdown and feature matrix.
- Added ASCII data flow architecture diagram mapping lifecycle from `session.idle` to TUI prompt injection.
- Added comparison table vs vanilla OpenCode and static snippet alternatives.
- Added full commented configuration reference covering seed, reseed, suggestion, steering, and inference settings.
- Added comprehensive troubleshooting guide and FAQ covering top usage scenarios.
- Added formal contributions policy and license attribution.

---

## [v0.1.1] - 2026-08-17

### Added
- Added high-quality demo animation (`demo.gif`) accelerated 2x for fast visual onboarding.
- Added demo asset reference to `README.md`.

### Fixed
- Fixed Right Arrow key acceptance in TUI via direct terminal raw input stream sequence matching.
- Excluded Tab key from ghost acceptance to preserve native OpenCode mode switching.

---

## [v0.1.0] - 2026-08-17

### Added
- Initial release of **opencode-prompt-suggester**.
- Intent-aware next-prompt ghost suggestions for OpenCode.
- Fast fallback heuristics + LLM generation in hidden `[prompt-suggester]` sessions.
- Multi-step background repository intent seeder.
- Adaptive steering memory (accepted, edited, changed course).
- Built-in slash commands: `/suggester`, `/suggester on`, `/suggester off`, `/suggester reseed`.
