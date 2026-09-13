# claude-openrouter

Point Claude Code — the CLI **and** the VSCode extension — at OpenRouter models.

One command. It installs everything it needs, including Node.

**Windows** — PowerShell:

```powershell
$env:OPENROUTER_API_KEY="sk-or-v1-..."; irm https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.ps1 | iex
```

**macOS / Linux** — Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.sh | sh -s -- --key sk-or-v1-...
```

That is the whole install on a machine with nothing on it. Get a key first at
<https://openrouter.ai/keys> and put a few dollars of credit on it.

<details>
<summary>Already have Node 18+? There is a shorter way.</summary>

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-...
```

`--allow-git=root` is needed on npm 11+, where git-backed packages are blocked by default
(`EALLOWGIT`). It allows only the package you named and still blocks git-backed
dependencies. Older npm ignores the flag with a warning.

</details>

Node >= 18 (installed for you if missing), no npm dependencies, Windows / macOS / Linux.

New to all of this? → **[GETTING-STARTED.md](GETTING-STARTED.md)**, written from a blank machine.

## How it works

OpenRouter serves the **Anthropic Messages API natively** at
`https://openrouter.ai/api/v1/messages`. Claude Code already speaks that. So the whole
integration is a handful of environment variables in `~/.claude/settings.json`:

```jsonc
"env": {
  "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
  "ANTHROPIC_AUTH_TOKEN": "sk-or-v1-...",
  "ANTHROPIC_MODEL": "deepseek/deepseek-v4-flash-0731",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "z-ai/glm-5.3-flash"
}
```

**There is no proxy, no daemon, no port and nothing to keep running.**

Claude Code applies its `env` block to every session it starts, which is why one file
covers the terminal and the VSCode extension. Shell aliases — the usual advice — silently
miss the extension.

> **Earlier versions of this routed through [Claude Code Router](https://github.com/musistudio/claude-code-router).**
> That meant a native SQLite dependency, a background service, a port, and an autostart
> entry, and every one of those was a way for the install to fail on someone's machine.
> CCR 3.x also moved its config into a SQLite database, so the JSON config written by older
> versions of this script stopped being read at all. None of it was needed. The repo was
> called `ccr-openrouter` while that was true; GitHub redirects the old URL.

## Models

| slot | model | when |
|---|---|---|
| default, background | `deepseek/deepseek-v4-flash-0731` | everything |
| opus slot | `z-ai/glm-5.3-flash` | `/model opus`, when you want more |

At the time of writing that is $0.04/M in versus $0.15/M in.

**Which model is "cheap" is decided at install time from live prices, not hardcoded.** The
cheaper becomes the default; the pricier becomes the opus slot. If a provider reprices, the
roles follow instead of inverting. Both prices are printed so you can see the choice.

Edit the `WANTED` table at the top of `setup.js` for different models.

### Caching

Automatic, nothing to configure. Per OpenRouter's docs, *"Prompt caching with DeepSeek is
automated and does not require any additional configuration"* — same for Z.AI. DeepSeek
cache reads bill at 0.1x input; Z.AI cache writes are free. `cache_control` breakpoints are
only needed for Anthropic and Qwen models, which this never routes to.

## What the installer does

1. Installs Claude Code if it is missing.
2. Resolves both model slugs against the **live** catalogue, so a retired model fails at
   install time instead of on your first prompt.
3. Ranks them by price and assigns the slots.
4. Writes `~/.claude/settings.json` (backing up whatever was there).
5. Writes a statusline that names the model actually in use.
6. Writes a plain-language `~/.claude/CLAUDE.md` — see below.
7. Sends one real request and shows you the reply. A config that writes but does not work
   is a failed install, and you should learn that now.

## Prompt extras — off by default

Two optional pieces change *how the model is instructed*: a bundled prompt-compression hook
(caveman) and a plain-language `CLAUDE.md`. **Both are off unless you ask for them.**

```sh
node setup.js --key sk-or-v1-... --extras
```

They are off because on a small model they were observed producing turns that ran tools and
then printed nothing at all — the work happened, the answer did not. Instructions that can
cost you the reply are not a sensible default.

Installing without `--extras` actively removes them if a previous run put them there: the
hooks are unregistered and the `CLAUDE.md` block is stripped, leaving anything you wrote
around it. Files are deleted **only** when byte-identical to the bundled copy — if you have
your own build of these hooks, it is left on disk and reported, not removed.

What stays on by default is passive: routing, the version display, and usage logging. None
of it touches the prompt.

## It starts itself, and keeps itself current

When the install finishes it **launches Claude Code for you** — one pasted line takes you
from a blank machine to a working session, with no "now open a new terminal" homework. It
also prints the resolved path of the `claude` executable and of your settings file, so you
always know exactly what was configured and where. Pass `--no-launch` to stay at the shell.

It also installs a **SessionStart hook that keeps itself up to date**. Every time you start
Claude Code it checks — at most once every six hours — whether this repo has a newer commit,
and if so reapplies the setup in the background. The hook itself does almost nothing: it
rate-limits, detaches a child process and returns immediately, so it can never slow down or
break the session you are starting. Every path swallows its own errors by design. The
result lands on your next session, and a log of what happened is at
`~/.claude/openrouter-autoupdate.log`. Pass `--no-autoupdate` to skip it.

## Version, on every launch

The statusline ends with the installed version — the commit of this repo that is actually
on your machine:

```
● deepseek-v4-flash-0731 (cheap) | my-project | main | $0.0031 | v20d0269
```

When the session-start check finds a newer commit, it turns yellow immediately, whether or
not the update itself succeeds:

```
... | v20d0269 (update pending)
```

To compare directly against GitHub:

```sh
node setup.js --version
```

```
installed:  20d0269
github:     20d0269

Up to date — installed matches djerok/claude-openrouter@main.
```

## Cutting the per-request cost

The largest avoidable cost is not what you type, it is what is prepended to every request.
Each enabled MCP server sends its tool schemas on **every** call, whatever you asked —
"write snake.py" pays for your database tooling too.

```sh
node setup.js --trim              # list what is enabled
node setup.js --trim obsidian     # keep only obsidian
node setup.js --trim --none       # disable all of them
node setup.js --untrim            # put them all back
```

`~/.claude.json` is backed up first and the removed entries are stashed, so `--untrim` is
exact.

**The installer does not do this for you.** It reports what is enabled and leaves the choice
alone: quietly disabling someone's notes or database access to save tokens is not a trade a
setup script should make on its own.

`--usage` tells you whether it is worth doing — it reports input tokens per turn and what
share of them the provider's cache absorbed.

## Usage logging

Every assistant turn appends one line to `~/.claude/openrouter-usage.jsonl`. This is a
plain Stop hook — a small Node function reading the hook payload and writing a file. **No
model is involved and it costs nothing**; it is accounting, not analysis.

```sh
node setup.js --usage
```

shows live spend straight from OpenRouter (total, today, this week, this month, credit
remaining — the authoritative numbers) and the local totals per turn and per model.

The hook does not hard-code field names. It walks the payload and keeps anything that looks
like a token count, a cost or a duration, so it keeps working if the payload shape changes
and an unfamiliar field shows up in the log rather than being silently dropped.

`--no-usagelog` skips it. `--uninstall` removes the hook but **keeps the log** — it is your
data.

## Modes

```sh
npx --allow-git=root github:djerok/claude-openrouter --key sk-or-v1-...  # install
npx --allow-git=root github:djerok/claude-openrouter --status            # what is configured
npx --allow-git=root github:djerok/claude-openrouter --doctor            # diagnose, change nothing
npx --allow-git=root github:djerok/claude-openrouter --off               # back to your Anthropic account
npx --allow-git=root github:djerok/claude-openrouter --on                # back to OpenRouter
npx --allow-git=root github:djerok/claude-openrouter --uninstall         # restore the newest backup
npx --allow-git=root github:djerok/claude-openrouter --no-verify         # skip the live test
npx --allow-git=root github:djerok/claude-openrouter --no-extras         # skip CLAUDE.md, caveman, rtk
npx --allow-git=root github:djerok/claude-openrouter --no-launch         # do not start Claude Code at the end
npx --allow-git=root github:djerok/claude-openrouter --no-autoupdate     # do not self-update on session start
npx --allow-git=root github:djerok/claude-openrouter --usage             # token and spend totals
npx --allow-git=root github:djerok/claude-openrouter --no-usagelog       # do not log per-turn usage
npx --allow-git=root github:djerok/claude-openrouter --version           # installed version vs GitHub
npx --allow-git=root github:djerok/claude-openrouter --trim              # see/disable MCP servers
```

From a clone, use `node setup.js` in place of the `npx` part.

`--allow-git=root` is needed on npm 11+, where git-backed packages are blocked by default
(`EALLOWGIT`). `root` allows only the package you named and still blocks git-backed
dependencies. Older npm ignores the flag with a warning.

Key precedence: `--key` → `$OPENROUTER_API_KEY` → the key already in your settings.
No key is baked into the script.

## Statusline

```
● deepseek-v4-flash-0731 (cheap) | ⚙ high | my-project | main | $0.0031
```

Green dot means routed to OpenRouter, yellow means you are on your Anthropic account.
`cheap` / `dear` tells you which slot answered.

Claude Code's **top header may still say a Claude model name** — that part of the UI is not
driven by these variables. The bottom statusline is the one to trust.

## When the machine fights back

| Situation | What happens |
|---|---|
| No Node at all | Use a bootstrapper above; it installs Node first |
| Node older than 18 | Refused up front, with the version it found |
| Node installed but invisible to the shell | `install.ps1` rebuilds `PATH` in-process |
| `npm` missing though Node is present | Caught before anything installs |
| Claude Code installed but not on `PATH` | Located via `npm prefix -g` and run by absolute path |
| A proxy serving an HTML error page | Downloads checked by size and content, not exit code |
| Model retired or renamed | Caught against the live catalogue at install time |
| No credit on the account | The 401 is reported plainly, not left to surface later |
| Old install still pointing at `127.0.0.1` | Detected and replaced, and `--status` warns about it |

Installer exit codes are trusted nowhere — `winget` reports success while installing
nothing, so every step is verified by running the program and reading its output.

## Notes

- Your OpenRouter key is written to `~/.claude/settings.json`, created with `0600`.
- `--off` and `--on` flip between OpenRouter and your Anthropic account without losing
  either configuration.
- `--uninstall` restores the newest settings backup and removes the statusline and the
  `CLAUDE.md` block.

## Licence

MIT
