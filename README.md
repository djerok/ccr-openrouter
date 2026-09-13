# ccr-openrouter

One command points a fresh [Claude Code](https://github.com/anthropics/claude-code) install —
**CLI and VSCode extension** — at OpenRouter models, and gives you a statusline that tells
you which model actually answered.

```sh
npx --allow-git=root github:djerok/ccr-openrouter --key sk-or-v1-...
```

That is the whole install — no clone, no download, nothing to keep, and no `git` needed.

`--allow-git=root` is required on **npm 12 and newer**, where fetching git-backed packages is
off by default (`allow-git` defaults to `none`); without it you get `npm error code EALLOWGIT`.
`root` permits only the package you named on the command line and still blocks git-backed
*dependencies*, which is the part that setting exists to protect you from. On older npm the
flag is ignored with a warning, so the same line works everywhere.

If you would rather read the code before running it — reasonable, and this is a script that
edits your config — clone the repo and run `node setup.js --key ...` instead. Identical.

No npm dependencies. Node >= 18. Windows, macOS, Linux.

**New to this?** → **[GETTING-STARTED.md](GETTING-STARTED.md)** walks through it from a
machine with nothing installed: opening a terminal, installing Node, getting an OpenRouter
key, and what to do when a step fails. Windows, macOS and Linux side by side.

## Why

Claude Code speaks the Anthropic API. [Claude Code Router](https://github.com/musistudio/claude-code-router)
(CCR) translates that to any OpenAI-compatible provider. Wiring the two up by hand means
editing two JSON files, guessing model slugs, and discovering in the VSCode extension that
your shell aliases never applied there. This script does the whole thing and then proves it
works with a real request.

Default routing:

| route | model |
|---|---|
| `default`, `background` | `deepseek/deepseek-v4-flash-0731` |
| `think`, `longContext` | `z-ai/glm-5.3-flash` |

Change the `WANTED` table at the top of `setup.js` for anything else on OpenRouter.

## What it does

1. Installs `@anthropic-ai/claude-code` and `@musistudio/claude-code-router` if they are missing.
2. Resolves the model slugs against the **live** `https://openrouter.ai/api/v1/models`
   catalogue. A renamed or retired model fails loudly at install time instead of 404-ing on
   your first prompt; if the exact slug is gone it falls back to the highest-context model
   matching the same terms and says so.
3. Writes `~/.claude-code-router/config.json` — the provider, the routing table, and a
   locally generated token so the proxy is not an open relay on your machine.
4. Writes `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL = http://127.0.0.1:3456`.

   **This one setting is what covers both surfaces.** Claude Code applies its `env` block to
   every session it starts, so the VSCode extension inherits it with no VSCode-specific
   config and no shell aliases. Aliases are the usual advice and they silently miss the
   extension.
5. Installs a statusline that reports the routed model and the reasoning effort.
6. Installs an autostart entry, because the VSCode extension fails cold if the router is not
   already listening when the window opens.
7. Starts the router and sends one real request through it. A config that writes but does
   not route is a failed install, and you should find that out now rather than mid-task.

Every file it touches is copied to `<file>.bak.<timestamp>` first.

## Statusline

```
● deepseek-v4-flash-0731 (default) │ ⚙ high │ 📁 my-project │ ⎇ main │ $0.0031
```

- green `●` — model read from a recent routing decision in the CCR log, i.e. what really ran
- yellow `●` — no fresh log entry, so it is showing the configured route for that slot instead
- `⚙` — the reasoning effort CCR last sent upstream, falling back to your `effortLevel` setting

Claude Code's **top header will still say "Sonnet"**. That string is hardcoded in Claude Code
and is not a sign that anything is broken. The bottom statusline is the truthful one.

## Modes

```sh
npx --allow-git=root github:djerok/ccr-openrouter --key sk-or-v1-...   # install
npx --allow-git=root github:djerok/ccr-openrouter --status             # what is routed where, is the router up
npx --allow-git=root github:djerok/ccr-openrouter --off                # back to your Anthropic account
npx --allow-git=root github:djerok/ccr-openrouter --on                 # re-enable routing
npx --allow-git=root github:djerok/ccr-openrouter --uninstall          # restore backups, remove statusline + autostart
npx --allow-git=root github:djerok/ccr-openrouter --no-autostart       # skip the OS startup entry
npx --allow-git=root github:djerok/ccr-openrouter --no-verify          # skip the live round-trip test
```

From a clone, swap `npx --allow-git=root github:djerok/ccr-openrouter` for `node setup.js` in any of the above.

Key precedence: `--key` → `$OPENROUTER_API_KEY` → the key already in your CCR config.
There is no baked-in default, on purpose.

## After installing

- **CLI** — open a *new* terminal, run `claude`.
- **VSCode** — reload the window (`Ctrl+Shift+P` → Developer: Reload Window).
- Switch model mid-session: `/model openrouter,z-ai/glm-5.3-flash`

## Notes

- Your OpenRouter key is written to `~/.claude-code-router/config.json`, which this script
  creates with `0600`. Claude Code itself never sees it — it authenticates to the local
  router with a separate generated token.
- If you already had other CCR providers configured, they are preserved; only the
  `openrouter` provider and the routing table are replaced.
- Your Claude subscription and this are mutually exclusive per session — `--off` and `--on`
  flip between them without losing either config.

## Licence

MIT
