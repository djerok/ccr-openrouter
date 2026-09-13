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

**No Node on the machine?** The command above cannot help you — it *is* a Node program.
Use the bootstrapper instead, which installs Node first and then runs the setup:

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/djerok/ccr-openrouter/main/install.ps1))) -Key sk-or-v1-...
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/djerok/ccr-openrouter/main/install.sh | sh -s -- --key sk-or-v1-...
```

**New to this?** → **[GETTING-STARTED.md](GETTING-STARTED.md)** walks through it from a
machine with nothing installed: opening a terminal, installing Node, getting an OpenRouter
key, and what to do when a step fails. Windows, macOS and Linux side by side.

**Something broken?** `--doctor` reports the state of everything involved and changes
nothing. It prints no keys, so it is safe to paste into an issue.

## Why

Claude Code speaks the Anthropic API. [Claude Code Router](https://github.com/musistudio/claude-code-router)
(CCR) translates that to any OpenAI-compatible provider. Wiring the two up by hand means
editing two JSON files, guessing model slugs, and discovering in the VSCode extension that
your shell aliases never applied there. This script does the whole thing and then proves it
works with a real request.

Default routing:

| route | model | why |
|---|---|---|
| `default`, `background` | `deepseek/deepseek-v4-flash-0731` | the cheap one — everything lands here |
| `think`, `longContext` | `z-ai/glm-5.3-flash` | the expensive one — only when you ask it to think, or the context gets big |

At the time of writing that is $0.04/M in against $0.15/M in, a 3.75x difference, so the
split is worth having.

**Which model gets which role is decided at install time from live prices, not hardcoded.**
The cheaper of the two becomes `default` and `background`; the pricier becomes `think` and
`longContext`. If a provider reprices, the roles follow instead of silently inverting. The
setup prints both prices so you can see what it chose.

Change the `WANTED` table at the top of `setup.js` for anything else on OpenRouter — the
price ranking applies to whatever you put there.

### Caching

Automatic for both, no configuration. Per OpenRouter's docs, *"Prompt caching with DeepSeek
is automated and does not require any additional configuration"*, and the same for Z.AI.
DeepSeek cache reads bill at 0.1x input; Z.AI cache writes are free and reads are
discounted. You do not need to set `cache_control` anywhere — that is only required for
Anthropic and Qwen models, which this does not route to.

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
npx --allow-git=root github:djerok/ccr-openrouter --doctor             # diagnose the environment, change nothing
```

From a clone, swap `npx --allow-git=root github:djerok/ccr-openrouter` for `node setup.js` in any of the above.

Key precedence: `--key` → `$OPENROUTER_API_KEY` → the key already in your CCR config.
There is no baked-in default, on purpose.

## After installing

- **CLI** — open a *new* terminal, run `claude`.
- **VSCode** — reload the window (`Ctrl+Shift+P` → Developer: Reload Window).
- Switch model mid-session: `/model openrouter,z-ai/glm-5.3-flash`

## When the machine fights back

The setup is written on the assumption that the environment is broken, because on a fresh
machine it usually is.

| Situation | What happens |
|---|---|
| No Node at all | The `npx` line cannot run. Use a bootstrapper above — it installs Node, then runs the setup |
| Node older than 18 | Refused up front with the version it found. The bootstrappers upgrade it |
| Node installed but the terminal cannot see it | The PowerShell bootstrapper rebuilds `PATH` in-process, so no reopening is needed |
| `npm` missing although Node is present | Caught before anything is installed, with the per-platform fix |
| Package installs but the binary crashes | Distinguished from "not installed", repaired once automatically, and if it still fails the program's own stderr is quoted |
| Global bin not on `PATH` | The binary is located through `npm prefix -g` and invoked by absolute path instead |
| npm 12 blocking native build scripts | Installs pass `--allow-scripts` for the packages that need it |
| A proxy returning an HTML error page instead of a file | Downloads are checked by size and content, not by exit code |
| Model renamed or retired on OpenRouter | Caught at install time against the live catalogue, not on your first prompt |
| No credit on the OpenRouter account | The key check reports the 401 plainly rather than failing later inside Claude Code |

Installer exit codes are trusted nowhere. `winget` in particular reports success while
installing nothing, so every step is verified by running the program and reading its output.

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
