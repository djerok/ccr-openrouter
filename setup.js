#!/usr/bin/env node
/**
 * setup.js — point a fresh Claude Code install at OpenRouter models.
 *
 * Turns an unconfigured Claude Code (CLI *and* VSCode extension) into one that
 * routes every request through Claude Code Router (CCR) to OpenRouter, using:
 *
 *     default / background : deepseek/deepseek-v4-flash-0731
 *     think    / longContext: z-ai/glm-5.3-flash
 *
 * and installs a statusline that reports the model actually used plus the
 * reasoning effort that was sent with the request.
 *
 * Both surfaces are covered by one mechanism: the `env` block in
 * ~/.claude/settings.json. Claude Code applies it to every session it starts,
 * so there is no need for shell aliases, and the VSCode extension inherits it
 * without any VSCode-specific configuration.
 *
 * Usage:
 *   node setup.js --key sk-or-v1-...   # full install
 *   OPENROUTER_API_KEY=sk-or-v1-... node setup.js
 *   node setup.js --no-autostart       # skip the OS autostart entry
 *   node setup.js --no-verify          # skip the live end-to-end request
 *   node setup.js --off                # temporarily go back to Anthropic
 *   node setup.js --on                 # re-enable OpenRouter routing
 *   node setup.js --status             # show current routing state
 *   node setup.js --doctor             # diagnose a broken environment, change nothing
 *   node setup.js --uninstall          # restore the newest backups
 *
 * Requires Node >= 18 (uses global fetch). No npm dependencies.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Desired models, as (label, exact slug, fuzzy fallback) triples. The exact
// slug is checked against the live /models list at install time; if OpenRouter
// has renamed it, the fuzzy terms pick the closest surviving match rather than
// writing a config that 404s on the first request.
const WANTED = {
  fast: {
    label: 'DeepSeek V4 Flash 0731',
    slug: 'deepseek/deepseek-v4-flash-0731',
    fuzzy: ['deepseek', 'flash', '0731'],
  },
  smart: {
    label: 'GLM 5.3 Flash',
    slug: 'z-ai/glm-5.3-flash',
    fuzzy: ['glm', '5.3', 'flash'],
  },
};

const HOME = os.homedir();
const CCR_DIR = path.join(HOME, '.claude-code-router');
const CCR_CONFIG = path.join(CCR_DIR, 'config.json');
const CCR_LOG_DIR = path.join(CCR_DIR, 'logs');
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const STATUSLINE = path.join(CLAUDE_DIR, 'statusline-openrouter.js');
const STATE_FILE = path.join(CCR_DIR, 'ccr-openrouter-state.json');

const HOST = '127.0.0.1';
const PORT = 3456;
const BASE_URL = `http://${HOST}:${PORT}`;

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : null;
};

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

let step = 0;
const say = (msg) => console.log(`${C.cyan}[${++step}]${C.reset} ${msg}`);
const ok = (msg) => console.log(`    ${C.green}ok${C.reset}   ${msg}`);
const warn = (msg) => console.log(`    ${C.yellow}warn${C.reset} ${msg}`);
const info = (msg) => console.log(`    ${C.dim}${msg}${C.reset}`);

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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak.${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** Run a command, returning { code, stdout, stderr }. Never throws. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: IS_WIN, // ccr/npm/claude are .cmd shims on Windows
    ...opts,
  });
  return {
    code: res.status === null ? 1 : res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
  };
}

/** Absolute path of a globally installed npm bin, or null. */
function globalBin(cmd) {
  const prefix = run('npm', ['prefix', '-g']).stdout;
  if (!prefix) return null;
  const candidates = IS_WIN
    ? [path.join(prefix, `${cmd}.cmd`), path.join(prefix, `${cmd}.ps1`), path.join(prefix, cmd)]
    : [path.join(prefix, 'bin', cmd), path.join(prefix, cmd)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Probe a command. Distinguishes the three outcomes that matter, because
 * conflating them produces a misleading error: the binary can be absent, or
 * present-but-unreachable on PATH, or present-and-reachable but crashing on
 * startup (e.g. a native dependency whose install script never ran).
 *
 * Returns { state: 'ok'|'broken'|'missing', version, path, stderr }.
 */
/**
 * Some programs validate their configuration before doing anything at all —
 * CCR refuses even `--version` with "No available models" until a provider
 * exists. That is a working install with nothing configured yet, not a broken
 * one, and treating it as broken sends the user chasing a compiler.
 */
function isConfigComplaint(stderr) {
  return /no available models|configure at least one|config(uration)? (file )?(not found|missing|invalid)/i.test(
    stderr
  );
}

function probeCommand(cmd) {
  for (const args of [['--version'], ['-v']]) {
    const res = run(cmd, args);
    if (res.code === 0 && res.stdout) {
      return { state: 'ok', version: res.stdout.split('\n')[0], path: cmd, stderr: '' };
    }
    if (res.stderr && isConfigComplaint(res.stderr)) {
      return { state: 'ok', version: 'installed, unconfigured', path: cmd, stderr: '' };
    }
    // A non-zero exit with real stderr means it ran and failed — not missing.
    if (res.stderr && !/not recognized|not found|ENOENT/i.test(res.stderr)) {
      return { state: 'broken', version: null, path: cmd, stderr: res.stderr };
    }
  }

  // Not reachable by name. It may still be installed but off PATH.
  const abs = globalBin(cmd);
  if (!abs) return { state: 'missing', version: null, path: null, stderr: '' };

  for (const args of [['--version'], ['-v']]) {
    const res = run(abs, args);
    if (res.code === 0 && res.stdout) {
      return { state: 'ok', version: res.stdout.split('\n')[0], path: abs, stderr: '' };
    }
    if (res.stderr && isConfigComplaint(res.stderr)) {
      return { state: 'ok', version: 'installed, unconfigured', path: abs, stderr: '' };
    }
    if (res.stderr) {
      return { state: 'broken', version: null, path: abs, stderr: res.stderr };
    }
  }
  return { state: 'broken', version: null, path: abs, stderr: '(no output)' };
}

function commandExists(cmd) {
  const p = probeCommand(cmd);
  return p.state === 'ok' ? p.version : null;
}

/** npm >= 12 refuses to run dependency install scripts unless named explicitly. */
function npmMajor() {
  const v = run('npm', ['--version']).stdout;
  return Number((v.split('.')[0] || '0').replace(/\D/g, '')) || 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Prerequisites
// ---------------------------------------------------------------------------

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    die(
      `Node ${process.versions.node} is too old (need >= 18 for global fetch).`,
      'Install Node 18+ from https://nodejs.org and re-run.'
    );
  }
  ok(`node ${process.versions.node}`);
}

/**
 * npm ships with Node, so a missing npm means a partial or unusual install —
 * worth catching here rather than as a confusing failure three steps later.
 */
function checkNpm() {
  const v = run('npm', ['--version']).stdout;
  if (!v) {
    die(
      'npm is not available, even though Node is.',
      IS_WIN
        ? 'Reinstall Node from https://nodejs.org and leave "npm package manager" checked.'
        : 'On Debian/Ubuntu the nodejs package sometimes omits it:\n  sudo apt-get install -y npm\nOtherwise reinstall Node from https://nodejs.org.'
    );
  }
  ok(`npm ${v}`);

  // A corrupted cache produces install failures that look like network errors.
  const prefix = run('npm', ['prefix', '-g']).stdout;
  if (!prefix) {
    warn('npm could not report its global prefix — your npm config may be damaged');
    info('If installs fail below, try:  npm cache clean --force');
  }
}

/** Resolved absolute paths, so later calls never depend on PATH. */
const BIN = {};

const PERMS_HINT = IS_WIN
  ? 'If this is a permissions error, reopen the terminal as Administrator, or set a user-writable npm prefix:\n  npm config set prefix "%LOCALAPPDATA%\\npm"'
  : 'Try again with sudo, or set a user-writable npm prefix:\n  npm config set prefix "$HOME/.npm-global"';

/**
 * @param nativeDeps packages whose install scripts must run for the binary to
 *        work at all. npm >= 12 blocks these by default, and the failure shows
 *        up much later as the binary crashing on startup.
 */
function npmInstallGlobal(pkg, nativeDeps = []) {
  const args = ['install', '-g'];
  // Always pass it when there is something to allow. npm 11 already blocks
  // install scripts, npm 12 kept the behaviour, and older versions treat the
  // flag as unknown config — a warning, not a failure. Version-gating this was
  // a bug: it silently did nothing on npm 11.
  if (nativeDeps.length) args.push(`--allow-scripts=${nativeDeps.join(',')}`);
  args.push(pkg);
  return run('npm', args, { stdio: 'inherit' });
}

function ensureNpmPackage(binary, pkg, label, nativeDeps = []) {
  let probe = probeCommand(binary);

  if (probe.state === 'ok') {
    BIN[binary] = probe.path;
    ok(`${label} present (${probe.version})`);
    return;
  }

  if (probe.state === 'missing') {
    info(`${label} not found — installing ${pkg} globally (this takes a minute)`);
    const res = npmInstallGlobal(pkg, nativeDeps);
    if (res.code !== 0) die(`npm install -g ${pkg} failed (exit ${res.code}).`, PERMS_HINT);
    probe = probeCommand(binary);
  }

  // Installed, reachable, but exiting non-zero — a half-finished or corrupted
  // install. Attempt one repair before giving up, since the alternative is
  // telling the user to debug someone else's package.
  if (probe.state === 'broken') {
    if (nativeDeps.length) {
      warn(`${label} is installed but fails to start — reinstalling with its build scripts enabled`);
      info(`(npm ${npmMajor()} blocks install scripts by default: ${nativeDeps.join(', ')})`);
    } else {
      warn(`${label} is installed but fails to start — reinstalling it once`);
    }
    const res = npmInstallGlobal(pkg, nativeDeps);
    if (res.code === 0) probe = probeCommand(binary);
  }

  if (probe.state === 'ok') {
    BIN[binary] = probe.path;
    ok(`${label} installed`);
    return;
  }

  if (probe.state === 'broken') {
    die(
      `${label} is installed at ${probe.path} but crashes when run.`,
      `Its own error was:\n\n${probe.stderr.split('\n').slice(0, 8).join('\n')}\n\n` +
        `Most often this is an unbuilt native module. Try:\n` +
        `  npm install -g --allow-scripts=${(nativeDeps.join(',') || 'better-sqlite3')} ${pkg}\n` +
        `and if that fails, install the build tools it needs (Python 3 and a C++ compiler),\n` +
        `then re-run this script.`
    );
  }

  die(
    `${pkg} installed but "${binary}" is not runnable.`,
    `Nothing was found in your npm global bin directory:\n  ${run('npm', ['prefix', '-g']).stdout}\n` +
      `Add that directory to your PATH, open a new terminal, and re-run.\n${PERMS_HINT}`
  );
}

/**
 * Prefer the absolute path resolved at install time over a bare PATH lookup —
 * a freshly installed global bin is often not yet visible to this process.
 */
function ccrPath() {
  return BIN.ccr || globalBin('ccr') || 'ccr';
}

function runCcr(args, opts) {
  return run(ccrPath(), args, opts);
}

// ---------------------------------------------------------------------------
// 2. Resolve the API key and the model slugs against the live catalogue
// ---------------------------------------------------------------------------

function resolveKey() {
  // Deliberately has no default. A key baked into a script is a key that ends up
  // in someone's git history.
  const existing = readJson(CCR_CONFIG, {});
  const reused = (existing.Providers || []).find((p) => p.name === 'openrouter');

  const key =
    flagValue('--key') ||
    process.env.OPENROUTER_API_KEY ||
    (reused && reused.api_key) ||
    null;

  if (!key) {
    die(
      'No OpenRouter API key.',
      'Get one at https://openrouter.ai/keys, then either:\n' +
        '  node setup.js --key sk-or-v1-...\n' +
        '  OPENROUTER_API_KEY=sk-or-v1-... node setup.js'
    );
  }
  if (!/^sk-or-v1-[0-9a-f]{16,}$/i.test(key)) {
    die(
      'That does not look like an OpenRouter key (expected sk-or-v1-...).',
      'Pass a good one with --key, or set $OPENROUTER_API_KEY.'
    );
  }
  if (!flagValue('--key') && !process.env.OPENROUTER_API_KEY) {
    info('reusing the OpenRouter key already in your CCR config');
  }
  return key;
}

async function fetchCatalogue(key) {
  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    die(
      `Could not reach openrouter.ai: ${err.message}`,
      'Check your network/proxy. If you are behind a proxy, set HTTPS_PROXY before running.'
    );
  }
  if (res.status === 401) {
    die('OpenRouter rejected the key (401).', 'The key is invalid, revoked, or out of credit.');
  }
  if (!res.ok) die(`OpenRouter /models returned HTTP ${res.status}.`);
  const body = await res.json();
  if (!Array.isArray(body.data) || body.data.length === 0) {
    die('OpenRouter returned an empty model list.');
  }
  return body.data;
}

/**
 * Prefer the exact slug. If it is gone, take the highest-context model whose id
 * contains every fuzzy term — never silently fall through to something unrelated.
 */
function pickModel(catalogue, want) {
  const exact = catalogue.find((m) => m.id === want.slug);
  if (exact) return { ...exact, matchedBy: 'exact' };

  const candidates = catalogue
    .filter((m) => !m.id.startsWith('~') && !m.id.endsWith(':batch'))
    .filter((m) => want.fuzzy.every((t) => m.id.toLowerCase().includes(t)));

  if (candidates.length === 0) {
    die(
      `OpenRouter no longer lists "${want.slug}" and nothing matches [${want.fuzzy.join(', ')}].`,
      'Edit the WANTED table at the top of this script with a current slug from https://openrouter.ai/models'
    );
  }
  candidates.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
  return { ...candidates[0], matchedBy: 'fuzzy' };
}

// ---------------------------------------------------------------------------
// 3. CCR config
// ---------------------------------------------------------------------------

function localToken(existing) {
  // Reused across runs so an already-open VSCode window keeps working.
  if (existing && typeof existing === 'string' && existing.startsWith('sk-ccr-')) {
    return existing;
  }
  return 'sk-ccr-' + require('crypto').randomBytes(16).toString('hex');
}

function writeCcrConfig(key, fast, smart) {
  const prev = readJson(CCR_CONFIG, {});
  const token = localToken(prev.APIKEY);

  // Keep any providers the user already had; replace only ours.
  const otherProviders = (prev.Providers || []).filter((p) => p.name !== 'openrouter');

  const openrouter = {
    name: 'openrouter',
    api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
    api_key: key,
    models: [fast.id, smart.id],
    transformer: {
      // The openrouter transformer maps Anthropic-shaped requests (including
      // Claude Code's `thinking` block) onto OpenRouter's `reasoning` field,
      // so extended thinking and effort flow through without extra config.
      use: [['openrouter'], ['maxtoken', { max_tokens: 32000 }]],
    },
  };

  const config = {
    ...prev,
    APIKEY: token,
    HOST,
    PORT,
    API_TIMEOUT_MS: '600000',
    LOG: true,
    LOG_LEVEL: 'info',
    Providers: [openrouter, ...otherProviders],
    Router: {
      ...(prev.Router || {}),
      default: `openrouter,${fast.id}`,
      background: `openrouter,${fast.id}`,
      think: `openrouter,${smart.id}`,
      longContext: `openrouter,${smart.id}`,
      longContextThreshold: Math.max(
        20000,
        Math.floor((fast.context_length || 128000) * 0.6)
      ),
    },
  };

  const bak = backup(CCR_CONFIG);
  writeJson(CCR_CONFIG, config);
  if (bak) info(`previous CCR config backed up to ${path.basename(bak)}`);
  return { token, config };
}

// ---------------------------------------------------------------------------
// 4. Claude Code settings — the part that covers CLI *and* the VSCode extension
// ---------------------------------------------------------------------------

function routingEnv(token) {
  return {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: '',
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

function writeClaudeSettings(token) {
  const prev = readJson(CLAUDE_SETTINGS, {});
  const bak = backup(CLAUDE_SETTINGS);

  const next = {
    ...prev,
    env: { ...(prev.env || {}), ...routingEnv(token) },
    statusLine: {
      type: 'command',
      command: `"${process.execPath}" "${STATUSLINE}"`,
      padding: 0,
    },
  };

  // A pinned Anthropic-only model (e.g. "opus[1m]") is meaningless once every
  // request is routed, and on some versions it blocks startup. Park it so --off
  // can put it back.
  if (next.model) {
    next.__ccrOpenrouterParkedModel = next.model;
    delete next.model;
    info(`parked settings.model = "${next.__ccrOpenrouterParkedModel}" (restored by --off)`);
  }

  writeJson(CLAUDE_SETTINGS, next);
  if (bak) info(`previous Claude settings backed up to ${path.basename(bak)}`);
}

// ---------------------------------------------------------------------------
// 5. Statusline — model + effort/reasoning, written out by this installer
// ---------------------------------------------------------------------------

const STATUSLINE_SOURCE = String.raw`#!/usr/bin/env node
/**
 * statusline-openrouter.js — generated by ccr-openrouter/setup.js. Do not edit
 * by hand; re-run the installer instead.
 *
 * Claude Code pipes a JSON blob on stdin and renders whatever we print on
 * stdout. We answer the question the built-in header cannot: which OpenRouter
 * model actually served this turn, and with how much reasoning.
 *
 * Truth order for the model:
 *   1. the most recent routing decision in the CCR log  (what really happened)
 *   2. the CCR Router table, keyed by the class of model Claude Code asked for
 *   3. "?" — never guess silently
 *
 * Everything is wrapped in try/catch: a broken statusline must degrade to a
 * short string, never to an error that hides the prompt.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CCR_DIR = path.join(os.homedir(), '.claude-code-router');
const CONFIG = path.join(CCR_DIR, 'config.json');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

/** Read at most the last 64 KB of the newest CCR log — statuslines must be fast. */
function tailLog(bytes = 65536) {
  const dirs = [path.join(CCR_DIR, 'logs'), CCR_DIR];
  let newest = null;
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.log')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, ...st, mtimeMs: st.mtimeMs, size: st.size };
      } catch {}
    }
  }
  if (!newest) return { text: '', age: Infinity };
  try {
    const start = Math.max(0, newest.size - bytes);
    const fd = fs.openSync(newest.full, 'r');
    const len = newest.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), age: (Date.now() - newest.mtimeMs) / 1000 };
  } catch {
    return { text: '', age: Infinity };
  }
}

/** Last "provider,model" CCR resolved, if the log is recent enough to trust. */
function modelFromLog(text, age) {
  if (!text || age > 900) return null;
  const re = /(?:use model|routing to|selected model|model:)\s*"?([a-z0-9_.-]+,[^"\s,]+(?:\/[^"\s,]+)?)"?/gi;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last) return last;

  // Fall back to any bare OpenRouter-style slug mentioned late in the log.
  const slug = /"model"\s*:\s*"([a-z0-9_.-]+\/[a-z0-9_.:-]+)"/gi;
  while ((m = slug.exec(text)) !== null) last = m[1];
  return last;
}

/** Reasoning effort/budget CCR last sent upstream. */
function reasoningFromLog(text, age) {
  if (!text || age > 900) return null;
  const effort = /"reasoning"\s*:\s*\{[^}]*"effort"\s*:\s*"(\w+)"/gi;
  let m, last = null;
  while ((m = effort.exec(text)) !== null) last = m[1];
  if (last) return last;

  const budget = /"(?:budget_tokens|max_tokens)"\s*:\s*(\d{3,})[^}]*\}\s*(?=[,}])/gi;
  const think = /"thinking"\s*:\s*\{[^}]*"budget_tokens"\s*:\s*(\d+)/gi;
  while ((m = think.exec(text)) !== null) last = m[1];
  if (last) return Number(last) >= 1 ? formatBudget(Number(last)) : null;
  void budget;
  return null;
}

function formatBudget(n) {
  return n >= 1000 ? Math.round(n / 1000) + 'k tok' : n + ' tok';
}

/** Which Router slot Claude Code's requested model maps onto. */
function routeFor(modelId, ctxTokens, router) {
  const id = (modelId || '').toLowerCase();
  const threshold = Number(router.longContextThreshold || 60000);
  if (ctxTokens && ctxTokens > threshold && router.longContext) return 'longContext';
  if (id.includes('haiku') && router.background) return 'background';
  if ((id.includes('opus') || id.includes('think')) && router.think) return 'think';
  return 'default';
}

function shortModel(spec) {
  if (!spec) return null;
  const bare = spec.includes(',') ? spec.split(',').slice(1).join(',') : spec;
  return bare.split('/').pop();
}

function gitBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 400,
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const input = readStdin();
  const config = readConfig();
  const router = config.Router || {};

  const askedFor = (input.model && (input.model.id || input.model.display_name)) || '';
  const ctxTokens =
    (input.context && (input.context.used_tokens || input.context.total_tokens)) || 0;

  const { text, age } = tailLog();
  const logged = modelFromLog(text, age);
  const route = routeFor(askedFor, ctxTokens, router);
  const configured = router[route];

  const model = shortModel(logged) || shortModel(configured) || '?';
  const live = Boolean(logged);

  // Effort: what CCR actually sent, else Claude Code's own configured level.
  let effort = reasoningFromLog(text, age);
  if (!effort) {
    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')
      );
      effort = s.effortLevel || null;
    } catch {}
  }

  const dir = (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) || process.cwd();
  const branch = gitBranch(dir);
  const cost = input.cost && typeof input.cost.total_cost_usd === 'number'
    ? input.cost.total_cost_usd
    : null;

  const parts = [];
  parts.push(
    (live ? C.green : C.yellow) + '●' + C.reset +
    ' ' + C.bold + model + C.reset +
    C.dim + ' (' + route + ')' + C.reset
  );
  parts.push(C.magenta + '⚙ ' + (effort || 'no reasoning') + C.reset);
  parts.push(C.blue + '📁 ' + path.basename(dir) + C.reset);
  if (branch) parts.push(C.cyan + '⎇ ' + branch + C.reset);
  if (cost !== null && cost > 0) parts.push(C.dim + '$' + cost.toFixed(4) + C.reset);

  process.stdout.write(parts.join(C.dim + ' │ ' + C.reset));
}

try {
  main();
} catch (err) {
  process.stdout.write('\x1b[31m● statusline error\x1b[0m ' + String(err.message).slice(0, 60));
}
`;

function writeStatusline() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(STATUSLINE, STATUSLINE_SOURCE, { mode: 0o755 });
  ok(`statusline written to ${STATUSLINE}`);
}

// ---------------------------------------------------------------------------
// 6. Autostart — the VSCode extension fails cold if CCR is not already running
// ---------------------------------------------------------------------------

function installAutostart() {
  if (IS_WIN) {
    const startup = path.join(
      HOME,
      'AppData',
      'Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    if (!fs.existsSync(startup)) {
      warn('Startup folder not found — start CCR manually with `ccr start`.');
      return;
    }
    const cmd = path.join(startup, 'ccr-openrouter.cmd');
    fs.writeFileSync(
      cmd,
      [
        '@echo off',
        'rem Generated by ccr-openrouter/setup.js — keeps Claude Code Router up',
        'rem so the Claude Code VSCode extension always has a proxy to talk to.',
        `"${ccrPath()}" start`,
        ''
      ].join('\r\n')
    );
    ok(`autostart installed: ${cmd}`);
  } else {
    const rc = path.join(HOME, process.env.SHELL && process.env.SHELL.includes('zsh') ? '.zshrc' : '.bashrc');
    const line =
      '\n# ccr-openrouter: keep the router up for Claude Code\n' +
      `(pgrep -f claude-code-router >/dev/null 2>&1 || "${ccrPath()}" start >/dev/null 2>&1 &)\n`;
    try {
      const current = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
      if (!current.includes('ccr-openrouter')) fs.appendFileSync(rc, line);
      ok(`autostart appended to ${rc}`);
    } catch (err) {
      warn(`could not write ${rc}: ${err.message} — start CCR manually with \`ccr start\``);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Start CCR and prove the whole path works
// ---------------------------------------------------------------------------

async function waitForCcr(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function verifyRouting(token, expectModel) {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', // any Anthropic-shaped name; CCR re-routes it
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with the single word: routed' }],
    }),
    signal: AbortSignal.timeout(90000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from the router — ${text.slice(0, 300)}`);
  }
  let reply = '';
  try {
    const body = JSON.parse(text);
    reply = (body.content || []).map((b) => b.text || '').join('').trim();
  } catch {
    reply = text.slice(0, 120);
  }
  return { reply, expectModel };
}

// ---------------------------------------------------------------------------
// Modes: --on / --off / --status / --uninstall
// ---------------------------------------------------------------------------

function modeOff() {
  const s = readJson(CLAUDE_SETTINGS, {});
  if (!s.env || !s.env.ANTHROPIC_BASE_URL) {
    console.log('Routing is already off.');
    return;
  }
  const parked = {
    ANTHROPIC_BASE_URL: s.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: s.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: s.env.ANTHROPIC_API_KEY,
  };
  delete s.env.ANTHROPIC_BASE_URL;
  delete s.env.ANTHROPIC_AUTH_TOKEN;
  delete s.env.ANTHROPIC_API_KEY;
  if (s.__ccrOpenrouterParkedModel) {
    s.model = s.__ccrOpenrouterParkedModel;
    delete s.__ccrOpenrouterParkedModel;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: true, parked, at: new Date().toISOString() });
  console.log(`${C.green}Routing off.${C.reset} Claude Code is back on your Anthropic account.`);
  console.log(`${C.dim}Restart the CLI, or reload the VSCode window, for it to take effect.${C.reset}`);
}

function modeOn() {
  const state = readJson(STATE_FILE, {});
  const ccr = readJson(CCR_CONFIG, {});
  const token = (state.parked && state.parked.ANTHROPIC_AUTH_TOKEN) || ccr.APIKEY;
  if (!token) die('No saved router token — run a full install first (node setup.js).');
  const s = readJson(CLAUDE_SETTINGS, {});
  s.env = { ...(s.env || {}), ...routingEnv(token) };
  if (s.model) {
    s.__ccrOpenrouterParkedModel = s.model;
    delete s.model;
  }
  writeJson(CLAUDE_SETTINGS, s);
  writeJson(STATE_FILE, { off: false, at: new Date().toISOString() });
  console.log(`${C.green}Routing on.${C.reset} Restart the CLI / reload the VSCode window.`);
}

function modeStatus() {
  const s = readJson(CLAUDE_SETTINGS, {});
  const ccr = readJson(CCR_CONFIG, {});
  const router = ccr.Router || {};
  const on = Boolean(s.env && s.env.ANTHROPIC_BASE_URL);
  console.log(`${C.bold}Routing:${C.reset}   ${on ? C.green + 'ON → ' + s.env.ANTHROPIC_BASE_URL : C.yellow + 'OFF (using Anthropic directly)'}${C.reset}`);
  console.log(`${C.bold}default:${C.reset}    ${router.default || '-'}`);
  console.log(`${C.bold}think:${C.reset}      ${router.think || '-'}`);
  console.log(`${C.bold}background:${C.reset} ${router.background || '-'}`);
  console.log(`${C.bold}longContext:${C.reset} ${router.longContext || '-'} (over ${router.longContextThreshold || '-'} tokens)`);
  console.log(`${C.bold}statusLine:${C.reset} ${(s.statusLine && s.statusLine.command) || '-'}`);
  const probe = runCcr(['status']);
  console.log(`${C.bold}ccr:${C.reset}        ${probe.code === 0 ? probe.stdout.split('\n')[0] : C.red + 'not running' + C.reset}`);
}

/**
 * Report the state of everything this script depends on, changing nothing.
 * Intended for pasting into a bug report when an install fails.
 */
async function modeDoctor() {
  const line = (k, v, good) =>
    console.log(
      `${C.bold}${(k + ':').padEnd(16)}${C.reset}` +
        `${good === undefined ? '' : good ? C.green : C.red}${v}${C.reset}`
    );

  console.log(`${C.bold}ccr-openrouter doctor${C.reset}\n`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line('platform', `${process.platform} ${process.arch}`);
  line('node', process.versions.node, nodeMajor >= 18);
  line('node path', process.execPath);

  const npmV = run('npm', ['--version']).stdout;
  line('npm', npmV || 'MISSING', Boolean(npmV));
  if (npmV) {
    line('npm prefix', run('npm', ['prefix', '-g']).stdout || 'unknown');
    line('allow-git', run('npm', ['config', 'get', 'allow-git']).stdout || 'unset');
    line('allow-scripts', run('npm', ['config', 'get', 'allow-scripts']).stdout || 'unset');
  }

  for (const [bin, label] of [['claude', 'Claude Code'], ['ccr', 'Claude Code Router']]) {
    const p = probeCommand(bin);
    line(
      label.toLowerCase().replace(/\s+/g, '-'),
      p.state === 'ok' ? `${p.version}  (${p.path})` : `${p.state.toUpperCase()}${p.stderr ? ' — ' + p.stderr.split('\n')[0] : ''}`,
      p.state === 'ok'
    );
  }

  for (const [label, file] of [
    ['ccr config', CCR_CONFIG],
    ['claude settings', CLAUDE_SETTINGS],
    ['statusline', STATUSLINE],
  ]) {
    line(label, fs.existsSync(file) ? file : 'not present', fs.existsSync(file));
  }

  let routerUp = false;
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
    routerUp = res.status < 500;
  } catch {}
  line('router', routerUp ? `listening on ${BASE_URL}` : `nothing on ${BASE_URL}`, routerUp);

  let net = false;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(15000),
    });
    net = res.ok;
  } catch {}
  line('openrouter', net ? 'reachable' : 'UNREACHABLE', net);
  for (const v of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (process.env[v]) line(v.toLowerCase(), process.env[v]);
  }

  console.log(
    `\n${C.dim}Paste this into an issue if something is wrong. It contains no keys.${C.reset}`
  );
}

function modeUninstall() {
  let restored = 0;
  for (const file of [CLAUDE_SETTINGS, CCR_CONFIG]) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let baks;
    try {
      baks = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.bak.')).sort();
    } catch {
      continue;
    }
    if (baks.length === 0) {
      warn(`no backup found for ${file}`);
      continue;
    }
    const newest = path.join(dir, baks[baks.length - 1]);
    fs.copyFileSync(newest, file);
    console.log(`restored ${file} from ${baks[baks.length - 1]}`);
    restored++;
  }
  for (const extra of [
    STATUSLINE,
    path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ccr-openrouter.cmd'),
  ]) {
    try {
      fs.unlinkSync(extra);
      console.log(`removed ${extra}`);
    } catch {}
  }
  console.log(restored ? `${C.green}Uninstalled.${C.reset}` : `${C.yellow}Nothing to restore.${C.reset}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function install() {
  console.log(`${C.bold}Claude Code → OpenRouter setup${C.reset}\n`);

  say('Checking prerequisites');
  checkNode();
  checkNpm();
  ensureNpmPackage('claude', '@anthropic-ai/claude-code', 'Claude Code');

  const key = resolveKey();

  say('Resolving models against the live OpenRouter catalogue');
  const catalogue = await fetchCatalogue(key);
  const fast = pickModel(catalogue, WANTED.fast);
  const smart = pickModel(catalogue, WANTED.smart);
  for (const [role, m, want] of [['fast ', fast, WANTED.fast], ['smart', smart, WANTED.smart]]) {
    const note = m.matchedBy === 'exact' ? '' : ` ${C.yellow}(fuzzy match — wanted ${want.slug})${C.reset}`;
    ok(`${role} → ${m.id}  ${C.dim}${(m.context_length || 0).toLocaleString()} ctx${C.reset}${note}`);
  }

  // The config is written before the router is installed, not after. CCR
  // refuses to start — including for `--version` — until at least one provider
  // with a model exists, so probing it on a machine with no config reports a
  // healthy install as broken.
  say('Writing the router config');
  const { token } = writeCcrConfig(key, fast, smart);
  ok(`${CCR_CONFIG}`);
  info(`local router token: ${token.slice(0, 12)}… (Claude Code authenticates to CCR with this, not with your OpenRouter key)`);

  say('Installing the router');
  ensureNpmPackage('ccr', '@musistudio/claude-code-router', 'Claude Code Router', [
    'better-sqlite3',
  ]);

  say('Writing the statusline');
  writeStatusline();

  say('Pointing Claude Code at the router (covers the CLI and the VSCode extension)');
  writeClaudeSettings(token);
  ok(`${CLAUDE_SETTINGS} → env.ANTHROPIC_BASE_URL = ${BASE_URL}`);

  if (!hasFlag('--no-autostart')) {
    say('Installing autostart');
    installAutostart();
  }

  say('Starting the router');
  runCcr(['restart']);
  const up = await waitForCcr();
  if (!up) {
    die(
      `CCR did not come up on ${BASE_URL} within 20s.`,
      'Run `ccr start` in a terminal and read the error it prints.'
    );
  }
  ok(`router listening on ${BASE_URL}`);

  if (!hasFlag('--no-verify')) {
    say('Verifying end to end (one real request through OpenRouter)');
    try {
      const { reply } = await verifyRouting(token, fast.id);
      ok(`round trip succeeded — model replied: ${JSON.stringify(reply.slice(0, 60))}`);
    } catch (err) {
      warn(`verification failed: ${err.message}`);
      warn('Config is written; fix the error above, then `ccr restart` and re-run with --no-verify skipped.');
    }
  }

  console.log(`\n${C.green}${C.bold}Done.${C.reset}\n`);
  console.log(`  ${C.bold}CLI:${C.reset}     open a NEW terminal and run  ${C.cyan}claude${C.reset}`);
  console.log(`  ${C.bold}VSCode:${C.reset}  reload the window (Ctrl+Shift+P → "Developer: Reload Window")\n`);
  console.log(`  default / background : ${fast.id}`);
  console.log(`  think / longContext  : ${smart.id}`);
  console.log(`  switch mid-session   : /model openrouter,${smart.id}`);
  console.log(`  back to Anthropic    : node setup.js --off\n`);
  console.log(`  ${C.dim}Claude Code's top header still says "Sonnet" — that string is hardcoded.`);
  console.log(`  The bottom statusline is the truthful one: it shows the routed model and reasoning effort.${C.reset}`);
}

(async () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*|^ \* ?/gm, ''));
    return;
  }
  if (hasFlag('--doctor')) return modeDoctor();
  if (hasFlag('--status')) return modeStatus();
  if (hasFlag('--off')) return modeOff();
  if (hasFlag('--on')) return modeOn();
  if (hasFlag('--uninstall')) return modeUninstall();
  await install();
})().catch((err) => die(err.stack || err.message));
