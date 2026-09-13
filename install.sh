#!/bin/sh
#
# Bootstrap claude-openrouter on a macOS or Linux machine that may have nothing
# installed.
#
# setup.js is a Node program, so it cannot install Node for itself. This script
# can. It installs Node if it is missing or too old, downloads setup.js, and
# runs it.
#
#   curl -fsSL https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.sh | sh -s -- --key sk-or-v1-...
#
# Every argument after `--` is forwarded to setup.js, so --status, --off and
# --on work the same way.
#
# Deliberately POSIX sh, not bash: some minimal containers and Alpine images
# have no bash, and this is the one script that has to run before anything is
# set up.

set -eu

MIN_NODE=18
RAW_BASE="https://raw.githubusercontent.com/djerok/claude-openrouter/main"

if [ -t 1 ]; then
  R=$(printf '\033[31m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  B=$(printf '\033[36m'); D=$(printf '\033[2m');  N=$(printf '\033[0m')
else
  R=''; G=''; Y=''; B=''; D=''; N=''
fi

step() { printf '%s[*]%s %s\n' "$B" "$N" "$1"; }
ok()   { printf '    %sok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '    %swarn%s %s\n' "$Y" "$N" "$1"; }
note() { printf '    %s%s%s\n' "$D" "$1" "$N"; }
fail() {
  printf '\n%sfatal:%s %s\n' "$R" "$N" "$1" >&2
  [ $# -gt 1 ] && printf '%s%s%s\n' "$D" "$2" "$N" >&2
  exit 1
}

has() { command -v "$1" >/dev/null 2>&1; }

# Truth comes from running node, never from a package manager's exit code.
node_major() {
  has node || { echo 0; return; }
  v=$(node --version 2>/dev/null || echo '')
  case "$v" in
    v*) echo "$v" | sed 's/^v\([0-9]*\)\..*/\1/' ;;
    *)  echo 0 ;;
  esac
}

fetch() {
  if has curl; then curl -fsSL "$1" -o "$2"
  elif has wget; then wget -qO "$2" "$1"
  else fail "Neither curl nor wget is installed." "Install one of them, then re-run."
  fi
}

install_node_nvm() {
  # nvm is the most reliable route on Linux: no sudo, and the distro packages
  # are frequently years behind the minimum this needs.
  note 'installing Node via nvm (no sudo required)'
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    fetch 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh' /tmp/nvm-install.sh \
      || fail 'Could not download the nvm installer.' 'Check your network, or install Node manually from https://nodejs.org'
    # shellcheck disable=SC1091
    PROFILE=/dev/null sh /tmp/nvm-install.sh >/dev/null 2>&1 || true
    rm -f /tmp/nvm-install.sh
  fi
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts >/dev/null 2>&1 || return 1
  nvm use --lts >/dev/null 2>&1 || return 1
  return 0
}

install_node() {
  step 'Installing Node.js'
  os=$(uname -s)

  if [ "$os" = "Darwin" ]; then
    if has brew; then
      note 'installing Node via Homebrew'
      brew install node >/dev/null 2>&1 || warn 'brew install node reported a problem'
      [ "$(node_major)" -ge "$MIN_NODE" ] && return 0
    fi
    install_node_nvm && return 0
    fail 'Could not install Node automatically on macOS.' \
      'Install Homebrew from https://brew.sh and run `brew install node`, or download the macOS installer from https://nodejs.org — then re-run this script.'
  fi

  # Linux. Try nvm first; it needs no root and gives a current version.
  if install_node_nvm; then
    [ "$(node_major)" -ge "$MIN_NODE" ] && return 0
  fi

  warn 'nvm did not work — falling back to the system package manager'
  if has apt-get;  then sudo apt-get update -qq && sudo apt-get install -y nodejs npm >/dev/null 2>&1 || true
  elif has dnf;    then sudo dnf install -y nodejs npm >/dev/null 2>&1 || true
  elif has yum;    then sudo yum install -y nodejs npm >/dev/null 2>&1 || true
  elif has pacman; then sudo pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || true
  elif has apk;    then sudo apk add --no-cache nodejs npm >/dev/null 2>&1 || true
  elif has zypper; then sudo zypper install -y nodejs npm >/dev/null 2>&1 || true
  else
    fail 'No supported package manager found.' 'Install Node 18+ yourself (https://nodejs.org), then re-run.'
  fi
  return 0
}

# --- Node -------------------------------------------------------------------

step 'Checking Node.js'
major=$(node_major)

if [ "$major" -ge "$MIN_NODE" ]; then
  ok "node $(node --version)"
else
  if [ "$major" -gt 0 ]; then
    warn "node $(node --version) is older than v$MIN_NODE — upgrading"
  else
    warn 'node not found'
  fi

  install_node
  major=$(node_major)

  if [ "$major" -lt "$MIN_NODE" ]; then
    fail 'Node still is not usable after trying to install it.' \
"Two things usually cause this:
  1. Node installed into a shell profile this script cannot see. Close this terminal,
     open a new one, and run the command again.
  2. Your distribution ships a version older than $MIN_NODE. Install a current one from
     https://nodejs.org or with nvm (https://github.com/nvm-sh/nvm), then re-run."
  fi
  ok "node $(node --version)"
fi

# --- npm --------------------------------------------------------------------

step 'Checking npm'
if ! has npm; then
  fail 'npm is missing even though Node is installed.' \
"On Debian/Ubuntu the nodejs package sometimes omits it:
  sudo apt-get install -y npm
Otherwise reinstall Node from https://nodejs.org, then re-run."
fi
ok "npm $(npm --version)"

# --- setup.js ---------------------------------------------------------------

step 'Downloading setup.js'
SETUP=$(mktemp /tmp/claude-openrouter-setup.XXXXXX.js)
trap 'rm -f "$SETUP"' EXIT INT TERM
fetch "$RAW_BASE/setup.js" "$SETUP" \
  || fail 'Could not download setup.js.' 'Check your network or proxy, then re-run.'

# A captive portal or proxy returning an HTML error page is the classic silent
# failure here, so inspect what actually arrived rather than trusting the fetch.
size=$(wc -c < "$SETUP" | tr -d ' ')
if [ "$size" -lt 5000 ] || ! head -n 1 "$SETUP" | grep -q node; then
  fail 'What downloaded is not setup.js.' \
    'Something on your network replaced the file. Try a different connection, or clone the repository manually.'
fi
ok "$((size / 1024)) KB"

# --- run --------------------------------------------------------------------

step 'Running setup'
echo
node "$SETUP" "$@"
