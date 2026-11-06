# opencode-prompt-suggester

Intent-aware next-prompt suggestions for OpenCode V2. After an assistant turn,
show an immediate suggestion and refine it with background inference. Insert the
suggestion to edit it, submit it through the normal composer, or dismiss it.

The project intent, steering history, prompt templates and configuration format
from 0.1.x are retained. Inference is stateless: the plugin creates no hidden
sessions and writes no inference messages into your conversation.

## Requirements

- OpenCode V2 with the `@opencode/plugin` 2.2.5 API or newer compatible 2.x API.
- Node.js 22.12 or newer for local development and building the Desktop bundle.
- The optional TUI prompt API patch for inserting/submitting suggestions in the
  terminal. Suggestions and settings work without that patch.

## Install

From a checkout of this V2 version, install dependencies and build the Desktop
part:

```bash
npm ci
npm run build
```

Add the package to OpenCode's V2 `plugins` configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/opencode-prompt-suggester" }
  ]
}
```

When migrating from 0.1.x, remove the old V1 `plugin` entries from `opencode.json`
and `tui.json`. Restart OpenCode and run `/suggester` to check status.

The package exports its server, TUI, RPC contract and built Desktop part.
`npm run build` rebuilds `dist/gui-experimental.cjs`; CI checks that the committed
bundle matches the source.

## Use

### Desktop

A pill above the composer displays the suggestion. Click it or press **Tab** to
insert the text, then edit it as usual. **Enter** in an empty normal composer
accepts and submits the suggestion through OpenCode's own Enter handler.
**Escape** dismisses it.

Acceptance requires an idle root session and an empty normal composer. Keyboard
acceptance also requires focus in the composer. Shell mode, subagents and
existing drafts never accept a suggestion. Agent, model and attached files stay
under the host composer's control.

### Terminal

A suggestion bar appears above the composer. **Ctrl+Alt+X** dismisses it on the
stock host. With the optional prompt API patch:

- **Space** or **Right** inserts the suggestion; `suggestion.ghostAcceptKeys`
  controls which keys are enabled.
- **Ctrl+Alt+N** submits it through the normal composer path.
- **Backspace** or **Ctrl+Alt+X** dismisses it.

Acceptance requires the current session's empty, focused composer. Without the
patch, the bar and slash commands remain available; accepting shows an explanatory
warning. See [the patch instructions](patches/README.md).

### Commands

Both interfaces support:

| Command | Behaviour |
| --- | --- |
| `/suggester` | Show enabled state, inference model and seed status. |
| `/suggester on` | Enable suggestions for the current project worktree. |
| `/suggester off` | Disable suggestions, cancel pending work and clear the current suggestion. |
| `/suggester refresh` | Regenerate a suggestion for an idle session. |
| `/suggester reseed` | Clear the project intent cache. Automatic reseeding follows the configuration below. |

Failed and interrupted executions use the immediate `continue` recovery
suggestion when `fastPathContinueOnError` is enabled. A new turn, dismissal,
disabling, session move or unload invalidates pending suggestion results.

## Configuration and state

The existing state directory is retained:

```text
${XDG_STATE_HOME:-~/.local/state}/opencode/opencode-prompt-suggester/
  config.json
  projects/<worktree-key>/config.json
  projects/<worktree-key>/seed.json
  projects/<worktree-key>/sessions/<session-id>/state.json
  projects/<worktree-key>/sessions/<session-id>/live.json
```

Project state is keyed by the resolved **worktree root**, so starting OpenCode
from a subdirectory uses the same configuration and seed. Linked worktrees keep
their own state, as before. Both interfaces access state through the server's RPC;
they do not need local access to the server's filesystem.

Global and project configuration are merged over [the defaults](src/domain/config.ts).
For example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "reseed": {
    "enabled": false,
    "turnCheckInterval": 10
  },
  "suggestion": {
    "customInstruction": "Prefer concise next steps",
    "fastPathContinueOnError": true,
    "ghostAcceptKeys": ["space", "right"],
    "maxSuggestionChars": 200
  },
  "inference": {
    "seederModel": "session-default",
    "suggesterModel": "small"
  }
}
```

Automatic reseeding remains disabled by default. When enabled, it checks the
cache after the first eligible turn and every `turnCheckInterval` turns.
`/suggester reseed` invalidates the cache; it does not override this policy.

Models accept `session-default`, `small`, or an explicit `provider/model`.
`session-default` uses the session's selected model, falling back to the host's
default. To choose a small model, add a plugin option:

```jsonc
{
  "plugins": [{
    "package": "./plugins/opencode-prompt-suggester",
    "options": { "smallModel": "openai/gpt-4o-mini" }
  }]
}
```

Without that option, `small` uses the host's default model.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Tests exercise the server entry, cancellation and event lifecycles, project state,
RPC routing, inference outcomes and both UI adapters with mocked host APIs.
They do not replace a smoke test in a running OpenCode host.

The server consumes lifecycle events independently of model inference. State
mutations are serialised per session, and each generation has an abort signal.
Late results from superseded turns are discarded. The UIs poll RPC snapshots and
reject responses from superseded requests, sessions and locations.

## About Contributions

> *About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Claude or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

---

## Licence

[MIT](LICENSE). Portions adapted from the
[pi-prompt-suggester](https://github.com/guwidoe/pi-prompt-suggester) architecture.
Independent project; not affiliated with OpenCode.
