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

## Plain-language mode

The installer writes `~/.claude/CLAUDE.md` telling Claude to answer like it is explaining to
a smart 10-year-old: small words, short sentences, answer first, exact commands rather than
paragraphs about commands. It goes in a marked block, so an existing `CLAUDE.md` is appended
to rather than overwritten, and `--uninstall` removes only that block.

Skip it with `--no-extras`.

## Token savers

Two optional extras, both skippable with `--no-extras`.

**caveman** is bundled and installed by default. It is a pair of Claude Code hooks that
compress replies — articles, filler and pleasantries are dropped, while code, commands and
error strings are left byte-for-byte intact. Fewer output tokens for the same content.

```
/caveman lite | full | ultra     switch level
stop caveman                     turn it off
```

The statusline shows a `[CAVEMAN]` badge when it is active, so the two do not fight over
the same slot.

**rtk** is *not* bundled. It is a separate third-party CLI that filters command output
before it reaches the model. There is no public source for it, and the name `rtk` on both
npm and crates.io belongs to an unrelated project ("Rust Type Kit"), so installing it by
name would give you the wrong program. If you have a source for it:

```sh
RTK_INSTALL_URL=<package-or-git-url> node setup.js --key sk-or-v1-...
```

An `rtk` already on your `PATH` is detected and left alone.

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
