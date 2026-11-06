# Optional TUI prompt API

OpenCode V2 2.2.5 does not expose composer insertion or submission to TUI plugins.
Suggestions, `/suggester` commands and `ctrl+alt+x` dismissal work on the stock
host. `ctrl+alt+n` explains that accepting a suggestion needs the optional
`ui.prompt` host API in `tui-prompt-api.patch`.
Desktop uses the existing composer API and needs no host patch.

Apply the patch from a compatible OpenCode `dev` checkout:

```bash
git apply /path/to/opencode-prompt-suggester/patches/tui-prompt-api.patch
bun install
bun run --cwd packages/plugin typecheck
bun run --cwd packages/tui typecheck
```

The patch adds `text`, `isEmpty`, `focused`, `set`, and `submit` to
`context.ui.prompt`. Insertion and submission refuse a missing, non-empty or
shell-mode composer; submission uses the host's normal prompt path.

With the patch, `ctrl+alt+n` submits, configured `space` / `right` keys insert,
and `backspace` also dismisses. The plugin checks focus through the prompt API
when it is available and keeps these bindings in the host's base input mode, so
dialogs retain their normal keyboard behaviour. Acceptance requires an empty
composer, including no attached parts; select attachments after inserting a
suggestion when needed.

The patch targets a specific host layout. Its contents are supplied for host
maintainers to review and adapt; applying it is separate from installing this
plugin. The plugin does not modify the OpenCode installation.
