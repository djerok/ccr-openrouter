#!/usr/bin/env node
/**
 * setup.js — point Claude Code at OpenRouter models.
 *
 * Works for the CLI and the VSCode extension at once, because both read the
 * `env` block in ~/.claude/settings.json.
 *
 *     default / background : the cheaper of the two models
 *     opus slot            : the pricier one, for when you ask it to think
 *
 * There is no proxy, no daemon and no background service. OpenRouter serves the
 * Anthropic Messages API natively at https://openrouter.ai/api/v1/messages, so
 * Claude Code talks to it directly. Earlier versions of this script routed
 * through Claude Code Router; that added a native SQLite dependency, a port, a
 * process to keep alive and an autostart entry, every one of which was a way
 * for the install to fail. None of it was necessary.
 *
 * Usage:
 *   node setup.js --key sk-or-v1-...   # install
 *   OPENROUTER_API_KEY=sk-or-v1-... node setup.js
 *   node setup.js --status             # what is configured
 *   node setup.js --doctor             # diagnose, change nothing
 *   node setup.js --off                # back to your Anthropic account
 *   node setup.js --on                 # back to OpenRouter
 *   node setup.js --uninstall          # restore the newest backup
 *   node setup.js --no-verify          # skip the live test request
 *   node setup.js --no-extras          # skip CLAUDE.md, caveman and rtk
 *   node setup.js --no-launch          # do not start Claude Code when finished
 *   node setup.js --no-autoupdate      # do not check GitHub for updates at session start
 *   node setup.js --quiet              # no output except warnings (used by the updater)
 *
 * Requires Node >= 18 (global fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Checked against the live catalogue at install time. If a slug is retired, the
// fuzzy terms find the closest surviving model rather than writing a config
// that fails on the first prompt.
const WANTED = {
  a: {
    label: 'DeepSeek V4 Flash 0731',
    slug: 'deepseek/deepseek-v4-flash-0731',
    fuzzy: ['deepseek', 'flash', '0731'],
  },
  b: {
    label: 'GLM 5.3 Flash',
    slug: 'z-ai/glm-5.3-flash',
    fuzzy: ['glm', '5.3', 'flash'],
  },
};

const API_ROOT = 'https://openrouter.ai/api';
const MODELS_URL = `${API_ROOT}/v1/models`;
const MESSAGES_URL = `${API_ROOT}/v1/messages`;

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const STATUSLINE = path.join(CLAUDE_DIR, 'statusline-openrouter.js');
const AUTOUPDATE = path.join(CLAUDE_DIR, 'hooks', 'openrouter-autoupdate.js');
const REPO = 'djerok/claude-openrouter';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const STATE_FILE = path.join(CLAUDE_DIR, 'openrouter-setup-state.json');
// Older installs wrote this name; still read it so --on keeps working.
const LEGACY_STATE_FILE = path.join(CLAUDE_DIR, 'ccr-openrouter-state.json');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

let step = 0;
// --quiet exists for the auto-update hook, which reinstalls in the background
// and must not scribble over a live terminal. Warnings still print.
const QUIET = argv.includes('--quiet');
const out = (m) => { if (!QUIET) console.log(m); };
const say = (m) => out(`${C.cyan}[${++step}]${C.reset} ${m}`);
const ok = (m) => out(`    ${C.green}ok${C.reset}   ${m}`);
const warn = (m) => console.log(`    ${C.yellow}warn${C.reset} ${m}`);
const info = (m) => out(`    ${C.dim}${m}${C.reset}`);

function die(msg, hint) {
  console.error(`\n${C.red}fatal:${C.reset} ${msg}`);
  if (hint) console.error(`${C.dim}${hint}${C.reset}`);
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    die(`${file} is not valid JSON: ${err.message}`, 'Fix or delete it, then re-run.');
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function run(cmd, args, opts = {}) {
  // Windows needs a shell to run .cmd/.ps1 shims. Node deprecated passing an
  // args array together with shell:true (DEP0190) because it concatenates them
  // unescaped, so when a shell is required the command line is built and quoted
  // here and the args array is left empty.
  const needsShell = IS_WIN && !/\.exe$/i.test(cmd);
  let file = cmd;
  let list = args;
  if (needsShell) {
    const quote = (a) => (/[\s&|<>^"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
    file = [quote(cmd), ...args.map(quote)].join(' ');
    list = [];
  }
  const res = spawnSync(file, list, { encoding: 'utf8', shell: needsShell, ...opts });
  return {
    code: res.status === null ? 1 : res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    die(
      `Node ${process.versions.node} is too old (need >= 18 for global fetch).`,
      'Install Node 18+ from https://nodejs.org, or use install.ps1 / install.sh which do it for you.'
    );
  }
  ok(`node ${process.versions.node}`);
}

/** Returns { version, path } for Claude Code, or null. */
function probeClaude() {
  const res = run('claude', ['--version']);
  if (res.code === 0 && res.stdout) {
    // Resolve the real file so the path printed at the end is something the
    // user can actually click, copy or hand to a bug report.
    const which = IS_WIN ? run('where', ['claude']) : run('which', ['claude']);
    const resolved = which.code === 0 && which.stdout ? which.stdout.split('\n')[0].trim() : 'claude';
    return { version: res.stdout.split('\n')[0], path: resolved };
  }
  const prefix = run('npm', ['prefix', '-g']).stdout;
  if (prefix) {
    const cands = IS_WIN
      ? [path.join(prefix, 'claude.cmd'), path.join(prefix, 'claude')]
      : [path.join(prefix, 'bin', 'claude'), path.join(prefix, 'claude')];
    for (const c of cands) {
      if (!fs.existsSync(c)) continue;
      const r = run(c, ['--version']);
      if (r.code === 0 && r.stdout) return { version: r.stdout.split('\n')[0], path: c };
    }
  }
  return null;
}

function ensureClaudeCode() {
  const v = probeClaude();
  if (v) {
    ok(`Claude Code present (${v.version})`);
    return v;
  }

  info('Claude Code not found — installing @anthropic-ai/claude-code globally');
  const res = run('npm', ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit' });
  if (res.code !== 0) {
    die(
      `npm install -g @anthropic-ai/claude-code failed (exit ${res.code}).`,
      IS_WIN
        ? 'If this is a permissions error, reopen the terminal as Administrator, or:\n  npm config set prefix "%LOCALAPPDATA%\\npm"'
        : 'Try sudo, or:\n  npm config set prefix "$HOME/.npm-global"'
    );
  }
  const after = probeClaude();
  if (!after) {
    die(
      'Claude Code installed but is not runnable.',
      `Add your npm global bin directory to PATH and open a new terminal:\n  ${run('npm', ['prefix', '-g']).stdout}`
    );
  }
  ok(`Claude Code installed (${after.version})`);
  return after;
}

// ---------------------------------------------------------------------------
// Key and models
// ---------------------------------------------------------------------------

function resolveKey() {
  // No baked-in default: a key inside a script is a key in someone's git history.
  const prev = readJson(CLAUDE_SETTINGS, {});
  const reused =
    prev.env && typeof prev.env.ANTHROPIC_AUTH_TOKEN === 'string' &&
    prev.env.ANTHROPIC_AUTH_TOKEN.startsWith('sk-or-')
      ? prev.env.ANTHROPIC_AUTH_TOKEN
      : null;

  const key = flagValue('--key') || process.env.OPENROUTER_API_KEY || reused;
  if (!key) {
    die('No OpenRouter API key.', [
      'Get one at https://openrouter.ai/keys (and put a few dollars of credit on it), then:',
      '  node setup.js --key sk-or-v1-...',
      '  OPENROUTER_API_KEY=sk-or-v1-... node setup.js',
    ].join('\n'));
  }
  if (!/^sk-or-v1-[0-9a-f]{16,}$/i.test(key)) {
    die('That does not look like an OpenRouter key (expected sk-or-v1-...).');
  }
  if (!flagValue('--key') && !process.env.OPENROUTER_API_KEY) {
    info('reusing the OpenRouter key already in your settings');
  }
  return key;
}

async function fetchCatalogue(key) {
  let res;
  try {
    res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    die(`Could not reach openrouter.ai: ${err.message}`,
      'Check your network. Behind a proxy, set HTTPS_PROXY before running.');
  }
  if (res.status === 401) die('OpenRouter rejected the key (401).', 'Invalid, revoked, or out of credit.');
  if (!res.ok) die(`OpenRouter /models returned HTTP ${res.status}.`);
  const body = await res.json();
  if (!Array.isArray(body.data) || !body.data.length) die('OpenRouter returned an empty model list.');
  return body.data;
}

/** Blended $/M, weighted 1:3 input:output — roughly a coding session's shape. */
function blendedPrice(m) {
  const p = m.pricing || {};
  return ((Number(p.prompt) || 0) * 3 + (Number(p.completion) || 0)) * 1e6 / 4;
}

function priceLabel(m) {
  const p = m.pricing || {};
  return `$${((Number(p.prompt) || 0) * 1e6).toFixed(2)}/M in, $${((Number(p.completion) || 0) * 1e6).toFixed(2)}/M out`;
}

function pickModel(catalogue, want) {
  const exact = catalogue.find((m) => m.id === want.slug);
  if (exact) return { ...exact, matchedBy: 'exact' };

  const candidates = catalogue
    .filter((m) => !m.id.startsWith('~') && !m.id.endsWith(':batch'))
    .filter((m) => want.fuzzy.every((t) => m.id.toLowerCase().includes(t)));
  if (!candidates.length) {
    die(`OpenRouter no longer lists "${want.slug}" and nothing matches [${want.fuzzy.join(', ')}].`,
      'Edit the WANTED table at the top of this script with a current slug from https://openrouter.ai/models');
  }
  candidates.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return { ...candidates[0], matchedBy: 'fuzzy' };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Several model variables are set rather than one. Claude Code has used
 * different names across versions for the small/background model, and an
 * unrecognised variable is ignored, so setting all of them is how this keeps
 * working across upgrades instead of silently falling back to a Claude model
 * the key cannot buy.
 */
function routingEnv(key, cheap, dear, contextTokens) {
  return {
    ANTHROPIC_BASE_URL: API_ROOT,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: cheap,
    ANTHROPIC_DEFAULT_MODEL: cheap,
    ANTHROPIC_SMALL_FAST_MODEL: cheap,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: cheap,
    ANTHROPIC_DEFAULT_SONNET_MODEL: cheap,
    ANTHROPIC_DEFAULT_OPUS_MODEL: dear,
    CLAUDE_CODE_SUBAGENT_MODEL: cheap,
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code only knows the context window of models in its own catalogue.
    // An OpenRouter slug is not in it, so without this it assumes 200k and
    // auto-compacts a 1.3M-token model at a sixth of its real window. The number
    // comes from the same catalogue response the models were chosen from.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens || 200000),
  };
}

const ROUTING_KEYS = Object.keys(routingEnv('', '', '', 0));

function writeClaudeSettings(key, cheap, dear, contextTokens, mutate) {
  const prev = readJson(CLAUDE_SETTINGS, {});
  const bak = backup(CLAUDE_SETTINGS);

  const env = { ...(prev.env || {}) };
  // Remove anything a previous proxy-based install left pointing at localhost.
  if (typeof env.ANTHROPIC_BASE_URL === 'string' && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) {
    info('replacing a stale local proxy URL from an older install');
  }
  Object.assign(env, routingEnv(key, cheap, dear, contextTokens));

  const next = { ...prev, env };
  next.statusLine = { type: 'command', command: `"${process.execPath}" "${STATUSLINE}"`, padding: 0 };
  if (typeof mutate === 'function') mutate(next);

  if (next.model) {
    next.__parkedModel = next.model;
    delete next.model;
    info(`parked settings.model = "${next.__parkedModel}" (restored by --off)`);
  }

  writeJson(CLAUDE_SETTINGS, next);
  if (bak) info(`previous settings backed up to ${path.basename(bak)}`);
}

// ---------------------------------------------------------------------------
// Statusline
// ---------------------------------------------------------------------------

const STATUSLINE_SOURCE = String.raw`#!/usr/bin/env node
/**
 * statusline-openrouter.js — generated by setup.js. Re-run the installer to
 * change it.
 *
 * Claude Code pipes a JSON blob on stdin and renders stdout. With direct
 * routing there is no proxy to interrogate: the model Claude Code names IS the
 * model that answered, so this reads it straight from stdin and falls back to
 * the configured default.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = { reset:'\x1b[0m', dim:'\x1b[2m', bold:'\x1b[1m', red:'\x1b[31m',
            green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m',
            magenta:'\x1b[35m', cyan:'\x1b[36m' };

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {}
  const env = settings.env || {};

  const routed = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.includes('openrouter');

  const reported = (input.model && (input.model.id || input.model.display_name)) || '';
  const configured = env.ANTHROPIC_MODEL || '';
  // Claude Code reports whatever id it sent. If that looks like a plain Claude
  // name we are not routed, so say so rather than claiming a model that is not
  // being used.
  const looksClaude = /^claude[-.]/i.test(reported);
  const model = routed ? (looksClaude ? configured : reported || configured) : reported || 'anthropic';
  const short = String(model).split('/').pop() || '?';

  const dear = env.ANTHROPIC_DEFAULT_OPUS_MODEL || '';
  const tier = routed && dear && model === dear ? 'dear' : routed ? 'cheap' : 'anthropic';

  const effort = settings.effortLevel || null;

  const dir = (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) || process.cwd();
  let branch = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 400 }).trim();
  } catch {}

  const cost = input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : null;

  // caveman ships its own statusline; rather than have two fight over the same
  // slot, show its state as a badge here.
  let caveman = null;
  try {
    const level = fs.readFileSync(path.join(os.homedir(), '.claude', '.caveman-active'), 'utf8').trim();
    if (level) caveman = level.toUpperCase();
  } catch {}

  const parts = [];
  if (caveman) parts.push(C.yellow + '[CAVEMAN' + (caveman === 'FULL' ? '' : ':' + caveman) + ']' + C.reset);
  parts.push((routed ? C.green : C.yellow) + '●' + C.reset + ' ' + C.bold + short + C.reset +
             C.dim + ' (' + tier + ')' + C.reset);
  if (effort) parts.push(C.magenta + '⚙ ' + effort + C.reset);
  parts.push(C.blue + path.basename(dir) + C.reset);
  if (branch) parts.push(C.cyan + branch + C.reset);
  if (cost !== null && cost > 0) parts.push(C.dim + '$' + cost.toFixed(4) + C.reset);

  process.stdout.write(parts.join(C.dim + ' | ' + C.reset));
}

try { main(); } catch (err) {
  process.stdout.write('\x1b[31m* statusline error\x1b[0m ' + String(err && err.message).slice(0, 60));
}
`;

function writeStatusline() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(STATUSLINE, STATUSLINE_SOURCE, { mode: 0o755 });
  ok(`statusline written to ${STATUSLINE}`);
}

// ---------------------------------------------------------------------------
// Extras: a plain-language CLAUDE.md and the token savers
// ---------------------------------------------------------------------------

const CLAUDE_MD_BEGIN = '<!-- BEGIN ccr-openrouter: plain language rules -->';
const CLAUDE_MD_END = '<!-- END ccr-openrouter -->';

const CLAUDE_MD_BODY = `${CLAUDE_MD_BEGIN}
# How to talk to me

Write like you are explaining to a smart 10-year-old. That is the whole rule.

## Words

- Use small words. "Use" not "utilize". "Fix" not "remediate". "Start" not "initiate".
- Short sentences. One idea each. If a sentence has two ideas, make it two sentences.
- No jargon unless it is the real name of a real thing. If you must use a hard word,
  say what it means right after, in the same sentence.
- Never say "simply", "just", "obviously", or "as you know". If it were obvious I would
  not be asking.

## Shape

- Answer first. Explain after. Do not warm up.
- Keep it short. If you can say it in one line, say it in one line.
- Use a list when there is more than one thing. Use a table when things compare.
- Show me the command or the code. Do not describe the command in a paragraph.

## When something breaks

1. Say what broke, in one line.
2. Say why, in one line.
3. Give me the exact thing to run or type to fix it.

Do not make me read three paragraphs to find the command.

## Being honest

- If you are not sure, say "I am not sure" and say what you would check.
- If you guessed, say it was a guess.
- If something failed, say it failed. Do not describe a failure as a success.
- If you did not do part of the job, say which part.

## Long chats

This chat has a size limit. When it fills up, old parts get thrown away and you forget
things. Watch for that and warn me **before** it happens, not after.

Tell me to run \`/compact\` when any of these is true:

- we just finished a task and are about to start a different one
- you pasted or read a lot of long output (a big file, a long log, lots of search results)
- you notice you are asking me things I already told you
- the chat has been going a long time and is still going

Say it in one line, like this:

> Good time to run \`/compact\` — we just finished the install and the logs took a lot of room.

Then wait. Do not run it yourself and do not nag me twice in a row about it.

## Do not

- Do not apologise more than once.
- Do not repeat my question back to me.
- Do not add features I did not ask for.
- Do not write a summary of what you are about to do, then do it. Just do it.
${CLAUDE_MD_END}`;

function writeClaudeMd() {
  let existing = '';
  try {
    existing = fs.readFileSync(CLAUDE_MD, 'utf8');
  } catch {}

  if (existing.includes(CLAUDE_MD_BEGIN)) {
    const re = new RegExp(
      escapeRe(CLAUDE_MD_BEGIN) + '[\\s\\S]*?' + escapeRe(CLAUDE_MD_END),
      'g'
    );
    fs.writeFileSync(CLAUDE_MD, existing.replace(re, CLAUDE_MD_BODY));
    ok(`refreshed the plain-language section of ${CLAUDE_MD}`);
    return;
  }

  if (existing.trim()) {
    backup(CLAUDE_MD);
    fs.writeFileSync(CLAUDE_MD, existing.replace(/\s*$/, '\n\n') + CLAUDE_MD_BODY + '\n');
    ok(`appended a plain-language section to your existing ${CLAUDE_MD}`);
  } else {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(CLAUDE_MD, CLAUDE_MD_BODY + '\n');
    ok(`wrote ${CLAUDE_MD}`);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

/**
 * A SessionStart hook that keeps this setup current.
 *
 * Hooks block the start of a Claude Code session, so this one does almost
 * nothing: it rate-limits itself, then detaches a child process and returns.
 * The child does the network call and any reinstall, and the result lands on
 * the next session. Nothing here can delay, or fail, the session you are
 * starting — every path swallows its errors on purpose.
 */
const AUTOUPDATE_SOURCE = String.raw`#!/usr/bin/env node
/**
 * openrouter-autoupdate.js — generated by setup.js. Re-run the installer to change it.
 *
 * SessionStart: checks GitHub for a newer commit of the setup and reapplies it.
 * Detaches immediately so it can never slow down or break a session.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = '__REPO__';
const RAW_BASE = '__RAW_BASE__';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // six hours
const DIR = path.join(os.homedir(), '.claude');
const STATE = path.join(DIR, 'openrouter-setup-state.json');
const LOG = path.join(DIR, 'openrouter-autoupdate.log');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); } catch {}
}
function log(msg) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

// --- child: the part that is allowed to take time -------------------------
async function runCheck() {
  const state = readState();
  state.lastCheck = Date.now();
  writeState(state);

  let sha;
  try {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/commits/main', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-openrouter-autoupdate' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return log('check failed: HTTP ' + res.status);
    sha = (await res.json()).sha;
  } catch (err) {
    return log('check failed: ' + err.message);
  }
  if (!sha) return log('check failed: no sha in response');

  if (sha === state.sha) {
    state.sha = sha;
    writeState(state);
    return log('up to date (' + sha.slice(0, 7) + ')');
  }

  log('update available: ' + String(state.sha).slice(0, 7) + ' -> ' + sha.slice(0, 7));

  let code;
  try {
    const res = await fetch(RAW_BASE + '/setup.js', { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return log('download failed: HTTP ' + res.status);
    code = await res.text();
  } catch (err) {
    return log('download failed: ' + err.message);
  }
  // Guard against a proxy handing back an error page.
  if (code.length < 5000 || !code.includes('ANTHROPIC_BASE_URL')) {
    return log('downloaded file did not look like setup.js');
  }

  const tmp = path.join(os.tmpdir(), 'claude-openrouter-update-' + Date.now() + '.js');
  try {
    fs.writeFileSync(tmp, code);
  } catch (err) {
    return log('could not write temp file: ' + err.message);
  }

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [tmp, '--no-verify', '--no-launch', '--quiet'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (c) => {
      log('reinstall exited ' + c);
      if (out.trim()) log('  ' + out.trim().split('\n').slice(-4).join('\n  '));
      if (c === 0) {
        const s = readState();
        s.sha = sha;
        writeState(s);
      }
      resolve();
    });
    child.on('error', (err) => { log('reinstall failed: ' + err.message); resolve(); });
  });

  try { fs.unlinkSync(tmp); } catch {}
}

// --- parent: must return instantly ----------------------------------------
if (process.argv includes_marker) {}
`;

function autoupdateSource() {
  // Assembled rather than templated so the child-mode dispatch stays readable.
  const body = AUTOUPDATE_SOURCE
    .replace('__REPO__', REPO)
    .replace('__RAW_BASE__', RAW_BASE)
    .replace('if (process.argv includes_marker) {}', `
if (process.argv[2] === '--run') {
  runCheck().catch((err) => log('unexpected: ' + err.message));
} else {
  // Parent path: rate-limit, detach, exit. Never block the session.
  try {
    const state = readState();
    const due = !state.lastCheck || Date.now() - state.lastCheck > CHECK_EVERY_MS;
    if (due) {
      const child = spawn(process.execPath, [__filename, '--run'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
  } catch {}
  process.exit(0);
}`.trim());
  return body;
}

function installAutoupdate(settings, sha) {
  fs.mkdirSync(path.dirname(AUTOUPDATE), { recursive: true });
  fs.writeFileSync(AUTOUPDATE, autoupdateSource(), { mode: 0o755 });

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = settings.hooks.SessionStart || [];
  const already = JSON.stringify(settings.hooks.SessionStart).includes('openrouter-autoupdate');
  if (!already) {
    settings.hooks.SessionStart.push({
      hooks: [{
        type: 'command',
        command: `"${process.execPath}" "${AUTOUPDATE}"`,
        timeout: 5,
        statusMessage: 'Checking for setup updates...',
      }],
    });
  }

  const state = readJson(STATE_FILE, {});
  state.sha = sha || state.sha || null;
  state.lastCheck = Date.now();
  writeJson(STATE_FILE, state);

  ok(`auto-update installed${sha ? ` (pinned at ${sha.slice(0, 7)})` : ''}`);
}

/** Current commit on main, or null if GitHub is unreachable. */
async function currentSha() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-openrouter-setup' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()).sha || null;
  } catch {
    return null;
  }
}

/**
 * caveman — a prompt-compression hook. It strips articles, filler and
 * pleasantries from replies while leaving code, commands and error strings
 * exactly as they are, which cuts output tokens without losing substance.
 *
 * Shipped in extras/caveman and copied into ~/.claude/hooks. Pure Node
 * builtins, no dependencies.
 */
const CAVEMAN_FILES = [
  'caveman-activate.js',
  'caveman-mode-tracker.js',
  'caveman-config.js',
  'cavecrew-model-overrides.js',
  'caveman-stats.js',
  'caveman-statusline.ps1',
  'caveman-statusline.sh',
  'package.json',
];

const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');

function installCaveman(settings) {
  const src = path.join(__dirname, 'extras', 'caveman');
  if (!fs.existsSync(src)) {
    info('caveman not bundled with this copy — skipping');
    return false;
  }

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  let copied = 0;
  for (const f of CAVEMAN_FILES) {
    const from = path.join(src, f);
    if (!fs.existsSync(from)) continue;
    const to = path.join(HOOKS_DIR, f);
    // Never clobber a newer local copy the user has edited themselves.
    try {
      if (fs.existsSync(to) && fs.statSync(to).mtimeMs > fs.statSync(from).mtimeMs) continue;
      fs.copyFileSync(from, to);
      copied++;
    } catch (err) {
      warn(`could not install ${f}: ${err.message}`);
    }
  }

  // Register the two hooks, without disturbing any the user already has.
  const node = process.execPath;
  const wanted = [
    ['SessionStart', path.join(HOOKS_DIR, 'caveman-activate.js'), 'Loading caveman mode...'],
    ['UserPromptSubmit', path.join(HOOKS_DIR, 'caveman-mode-tracker.js'), 'Tracking caveman mode...'],
  ];

  settings.hooks = settings.hooks || {};
  for (const [event, script, statusMessage] of wanted) {
    settings.hooks[event] = settings.hooks[event] || [];
    const already = JSON.stringify(settings.hooks[event]).includes(path.basename(script));
    if (already) continue;
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: 5, statusMessage }],
    });
  }

  ok(`caveman installed (${copied} files) — /caveman lite|full|ultra, or "stop caveman"`);
  return true;
}

/**
 * rtk is a separate tool and deliberately not bundled. The binary on the
 * author's machine is a third-party Windows executable with no public source,
 * and the name `rtk` on both npm and crates.io belongs to an unrelated project
 * (reachingforthejack/rtk, "Rust Type Kit"). Installing that by name would give
 * you the wrong program, so this only wires up a source you supply yourself.
 */
function installRtk() {
  if (run('rtk', ['--version']).code === 0) {
    ok('rtk already present');
    return true;
  }
  const source = process.env.RTK_INSTALL_URL;
  if (!source) {
    info('rtk not installed — set RTK_INSTALL_URL to a package or git URL to enable it');
    info('(do not `npm i -g rtk`: that name belongs to an unrelated project)');
    return false;
  }
  const res = run('npm', ['install', '-g', source], { stdio: 'inherit' });
  if (res.code !== 0) {
    warn('rtk install failed — continuing without it');
    return false;
  }
  ok('rtk installed');
  return true;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

async function verify(key, model) {
  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: routed' }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
  }
  if (body.type !== 'message') throw new Error(`unexpected response shape: ${text.slice(0, 200)}`);
  return body;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function modeOff() {
  const s = readJson(CLAUDE_SETTINGS, {});
  if (!s.env || !s.env.ANTHROPIC_BASE_URL) {
    console.log('Routing is already off.');
    return;
  }
  const parked = {};
  for (const k of ROUTING_KEYS) {
    if (k in s.env) {
      parked[k] = s.env[k];
      delete s.env[k];
    }
  }
  if (s.__parkedModel) {
    s.model = s.__parkedModel;
    delete s.__parkedModel;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: true, parked, at: new Date().toISOString() });
  console.log(`${C.green}Routing off.${C.reset} Claude Code is back on your Anthropic account.`);
  console.log(`${C.dim}Open a new terminal, or reload the VSCode window.${C.reset}`);
}

function modeOn() {
  const state = readJson(STATE_FILE, null) || readJson(LEGACY_STATE_FILE, {});
  if (!state.parked || !state.parked.ANTHROPIC_AUTH_TOKEN) {
    die('Nothing saved to switch back to.', 'Run a full install:  node setup.js --key sk-or-v1-...');
  }
  const s = readJson(CLAUDE_SETTINGS, {});
  s.env = { ...(s.env || {}), ...state.parked };
  if (s.model) {
    s.__parkedModel = s.model;
    delete s.model;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: false, parked: state.parked, at: new Date().toISOString() });
  console.log(`${C.green}Routing on.${C.reset} Open a new terminal, or reload the VSCode window.`);
}

function modeStatus() {
  const s = readJson(CLAUDE_SETTINGS, {});
  const env = s.env || {};
  const on = typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.includes('openrouter');
  const line = (k, v) => console.log(`${C.bold}${(k + ':').padEnd(14)}${C.reset}${v}`);

  line('routing', on ? `${C.green}ON -> ${env.ANTHROPIC_BASE_URL}${C.reset}`
                     : `${C.yellow}OFF (using your Anthropic account)${C.reset}`);
  line('default', env.ANTHROPIC_MODEL || '-');
  line('background', env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '-');
  line('opus slot', env.ANTHROPIC_DEFAULT_OPUS_MODEL || '-');
  line('context', env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    ? Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toLocaleString() + ' tokens' : '-');
  line('key', env.ANTHROPIC_AUTH_TOKEN ? env.ANTHROPIC_AUTH_TOKEN.slice(0, 12) + '...' : '-');
  line('statusline', (s.statusLine && s.statusLine.command) || '-');
  if (env.ANTHROPIC_BASE_URL && /127\.0\.0\.1|localhost/.test(env.ANTHROPIC_BASE_URL)) {
    console.log(`\n${C.red}This points at a local proxy that this version no longer installs.${C.reset}`);
    console.log(`Re-run the setup to fix it, or ${C.bold}node setup.js --off${C.reset} to go back to Anthropic.`);
  }
}

async function modeDoctor() {
  const line = (k, v, good) =>
    console.log(`${C.bold}${(k + ':').padEnd(16)}${C.reset}` +
      `${good === undefined ? '' : good ? C.green : C.red}${v}${C.reset}`);

  console.log(`${C.bold}openrouter setup doctor${C.reset}\n`);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line('platform', `${process.platform} ${process.arch}`);
  line('node', process.versions.node, nodeMajor >= 18);
  const npmV = run('npm', ['--version']).stdout;
  line('npm', npmV || 'MISSING', Boolean(npmV));
  const cc = probeClaude();
  line('claude code', cc ? `${cc.version}  ${cc.path}` : 'MISSING', Boolean(cc));

  const s = readJson(CLAUDE_SETTINGS, {});
  const env = s.env || {};
  line('settings', fs.existsSync(CLAUDE_SETTINGS) ? CLAUDE_SETTINGS : 'not present', fs.existsSync(CLAUDE_SETTINGS));
  line('base url', env.ANTHROPIC_BASE_URL || 'unset',
    Boolean(env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL.includes('openrouter')));
  line('default model', env.ANTHROPIC_MODEL || 'unset', Boolean(env.ANTHROPIC_MODEL));
  line('statusline', fs.existsSync(STATUSLINE) ? STATUSLINE : 'not present', fs.existsSync(STATUSLINE));
  line('CLAUDE.md', fs.existsSync(CLAUDE_MD) ? CLAUDE_MD : 'not present', fs.existsSync(CLAUDE_MD));

  let net = false;
  try {
    net = (await fetch(MODELS_URL, { signal: AbortSignal.timeout(15000) })).ok;
  } catch {}
  line('openrouter', net ? 'reachable' : 'UNREACHABLE', net);

  if (env.ANTHROPIC_AUTH_TOKEN) {
    let auth = 'unknown';
    let good = false;
    try {
      const r = await fetch(`${API_ROOT}/v1/key`, {
        headers: { Authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` },
        signal: AbortSignal.timeout(15000),
      });
      auth = r.ok ? 'accepted' : `REJECTED (HTTP ${r.status})`;
      good = r.ok;
    } catch (e) {
      auth = `could not check: ${e.message}`;
    }
    line('key', auth, good);
  }

  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[v]) line(v.toLowerCase(), process.env[v]);
  }
  console.log(`\n${C.dim}Safe to paste into an issue — it prints no keys.${C.reset}`);
}

function modeUninstall() {
  const baks = (() => {
    try {
      return fs.readdirSync(CLAUDE_DIR)
        .filter((f) => f.startsWith('settings.json.bak.'))
        .sort();
    } catch {
      return [];
    }
  })();

  if (baks.length) {
    const newest = path.join(CLAUDE_DIR, baks[baks.length - 1]);
    fs.copyFileSync(newest, CLAUDE_SETTINGS);
    console.log(`restored ${CLAUDE_SETTINGS} from ${baks[baks.length - 1]}`);
  } else {
    warn('no settings backup found — removing the routing keys instead');
    const s = readJson(CLAUDE_SETTINGS, {});
    if (s.env) for (const k of ROUTING_KEYS) delete s.env[k];
    if (s.__parkedModel) {
      s.model = s.__parkedModel;
      delete s.__parkedModel;
    }
    writeJson(CLAUDE_SETTINGS, s);
  }

  try {
    fs.unlinkSync(STATUSLINE);
    console.log(`removed ${STATUSLINE}`);
  } catch {}

  try {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    if (md.includes(CLAUDE_MD_BEGIN)) {
      const re = new RegExp('\\n*' + escapeRe(CLAUDE_MD_BEGIN) + '[\\s\\S]*?' + escapeRe(CLAUDE_MD_END) + '\\n*', 'g');
      const stripped = md.replace(re, '\n');
      if (stripped.trim()) fs.writeFileSync(CLAUDE_MD, stripped);
      else fs.unlinkSync(CLAUDE_MD);
      console.log(`cleaned ${CLAUDE_MD}`);
    }
  } catch {}

  console.log(`${C.green}Uninstalled.${C.reset} Open a new terminal, or reload the VSCode window.`);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function install() {
  out(`${C.bold}Claude Code -> OpenRouter${C.reset}\n`);

  say('Checking prerequisites');
  checkNode();
  const claudeBin = ensureClaudeCode();

  const key = resolveKey();

  say('Resolving models against the live OpenRouter catalogue');
  const catalogue = await fetchCatalogue(key);
  const first = pickModel(catalogue, WANTED.a);
  const second = pickModel(catalogue, WANTED.b);

  // Cheap vs expensive comes from live prices, not from the order above, so a
  // reprice cannot silently invert the whole routing table.
  const [cheap, dear] = [first, second].sort((x, y) => blendedPrice(x) - blendedPrice(y));
  ok(`cheap -> ${cheap.id}  ${C.dim}${priceLabel(cheap)}${C.reset}`);
  ok(`dear  -> ${dear.id}  ${C.dim}${priceLabel(dear)}${C.reset}`);
  for (const m of [first, second]) {
    if (m.matchedBy === 'fuzzy') warn(`${m.id} was a fuzzy match — the exact slug is gone`);
  }

  say('Writing the statusline');
  writeStatusline();

  say('Pointing Claude Code at OpenRouter (covers the CLI and the VSCode extension)');
  const extras = !hasFlag('--no-extras');
  // The smaller of the two windows: one setting covers both models, and
  // over-stating it would let a session grow past what the other can accept.
  const contextTokens = Math.min(
    cheap.context_length || 200000,
    dear.context_length || 200000
  );
  const sha = await currentSha();
  writeClaudeSettings(key, cheap.id, dear.id, contextTokens, (settings) => {
    if (extras) installCaveman(settings);
    if (!hasFlag('--no-autoupdate')) installAutoupdate(settings, sha);
  });
  ok(`${CLAUDE_SETTINGS} -> env.ANTHROPIC_BASE_URL = ${API_ROOT}`);
  info(`default ${cheap.id} | opus slot ${dear.id}`);
  info(`context window ${contextTokens.toLocaleString()} tokens`);

  if (extras) {
    say('Writing plain-language instructions');
    writeClaudeMd();

    say('Token savers');
    installRtk();
  }

  if (!hasFlag('--no-verify')) {
    say('Verifying with one real request');
    try {
      const body = await verify(key, cheap.id);
      const said = (body.content || []).map((b) => b.text || '').join('').trim();
      ok(`${body.model} replied${said ? `: ${JSON.stringify(said.slice(0, 40))}` : ' (thinking-only, still a success)'}`);
      if (body.usage) info(`billed ${body.usage.input_tokens} in / ${body.usage.output_tokens} out`);
    } catch (err) {
      warn(`verification failed: ${err.message}`);
      warn('Settings are written. Fix the error above and run --doctor.');
    }
  }

  const target = claudeBin ? claudeBin.path : 'claude';

  out(`\n${C.green}${C.bold}Done.${C.reset}\n`);
  out(`  ${C.bold}claude:${C.reset}             ${target}`);
  out(`  ${C.bold}settings:${C.reset}           ${CLAUDE_SETTINGS}`);
  out(`  everyday model     : ${cheap.id}`);
  out(`  when you need more : ${C.cyan}/model opus${C.reset} -> ${dear.id}`);
  out(`  back to Anthropic  : node setup.js --off`);
  out(`  ${C.bold}VSCode:${C.reset}             reload the window (Ctrl+Shift+P -> "Developer: Reload Window")`);
  out(`\n  ${C.dim}No proxy, no background service, nothing to keep running.${C.reset}`);

  // Auto-launch. The point of this script is that one pasted line ends with a
  // working Claude Code, so finishing at a shell prompt with homework ("now
  // open a new terminal") is a worse ending than simply starting it.
  if (hasFlag('--no-launch') || QUIET) {
    out(`\n  ${C.dim}Start it with:${C.reset} ${C.cyan}claude${C.reset}`);
    return;
  }
  if (!process.stdout.isTTY) {
    out(`\n  ${C.dim}Not an interactive terminal, so not launching. Run:${C.reset} ${C.cyan}claude${C.reset}`);
    return;
  }

  out(`\n  ${C.cyan}Starting Claude Code...${C.reset}\n`);
  const res = spawnSync(target, [], {
    stdio: 'inherit',
    // The settings file is written already and a fresh process reads it, but
    // passing the same variables here means this very first session is routed
    // even if something is odd about how settings are picked up.
    env: { ...process.env, ...routingEnv(key, cheap.id, dear.id, contextTokens) },
    shell: IS_WIN && !/\.exe$/i.test(target),
  });
  if (res.error) {
    warn(`could not start Claude Code automatically: ${res.error.message}`);
    out(`  Start it yourself with: ${C.cyan}claude${C.reset}`);
  }
}

// ---------------------------------------------------------------------------

(async () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?|^ \*/gm, ''));
    return;
  }
  if (hasFlag('--doctor')) return modeDoctor();
  if (hasFlag('--status')) return modeStatus();
  if (hasFlag('--off')) return modeOff();
  if (hasFlag('--on')) return modeOn();
  if (hasFlag('--uninstall')) return modeUninstall();
  await install();
})().catch((err) => die(err.stack || err.message));
