#!/usr/bin/env bash
# setup-claude-hack.sh — run Claude Code on your hackathon API credits,
# without touching your normal Claude Pro/Max login.
#
# Usage (macOS or Linux):
#   bash setup-claude-hack.sh
# Then, in any project folder:
#   claude-hack
#
# What it does:
#   1. Installs Claude Code (official installer) if it's missing.
#   2. Asks for your API key (input hidden) and checks it works.
#   3. Saves the key in ~/.claude-hackathon/api_key (only you can read it).
#   4. Creates a `claude-hack` command that uses that key and a separate
#      config folder, defaulting to Sonnet to stretch the credits.
# Plain `claude` keeps using your normal login.
#
# To undo:  rm -rf ~/.claude-hackathon ~/.local/bin/claude-hack

set -euo pipefail

CONFIG_DIR="$HOME/.claude-hackathon"
KEY_FILE="$CONFIG_DIR/api_key"
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/claude-hack"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Pick the shell config file to update.
case "${SHELL:-}" in
  */zsh)  RC="$HOME/.zshrc" ;;
  */bash) if [[ "$(uname)" == "Darwin" ]]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
  *)      RC="$HOME/.profile" ;;
esac

# ---------------------------------------------------------------------------
say "1/4  Claude Code"
export PATH="$BIN_DIR:$PATH"
if command -v claude >/dev/null 2>&1; then
  ok "Already installed: $(claude --version 2>/dev/null | head -n1)"
else
  echo "  Installing with the official installer (no sudo needed)..."
  curl -fsSL https://claude.ai/install.sh | bash
  command -v claude >/dev/null 2>&1 || die "Install finished but 'claude' isn't found. Open a new terminal and rerun this script."
  ok "Installed: $(claude --version 2>/dev/null | head -n1)"
fi

# ---------------------------------------------------------------------------
say "2/4  Your API key"
echo "  Create it in platform.claude.com INSIDE A WORKSPACE:"
echo "  Settings → Workspaces → (pick or create one) → API Keys → Create Key"
echo "  (A key created outside a workspace fails with a 'workspace-id header' error.)"
echo
printf "  Paste your API key (hidden): "
IFS= read -rs API_KEY
echo
API_KEY="$(printf '%s' "$API_KEY" | tr -d '[:space:]')"
[[ "$API_KEY" == sk-ant-* ]] || die "That doesn't look like an Anthropic API key (should start with sk-ant-)."

echo "  Checking the key..."
RESP="$(curl -sS -w $'\n%{http_code}' https://api.anthropic.com/v1/models \
  -H "x-api-key: $API_KEY" -H "anthropic-version: 2023-06-01" || true)"
CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"
if [[ "$CODE" == "200" ]]; then
  ok "Key works"
elif grep -qi "workspace" <<<"$BODY"; then
  die "This key isn't in a workspace. Create a new key inside a workspace (see above) and rerun."
elif [[ "$CODE" == "401" ]]; then
  die "Key rejected (401). Check you copied the whole key, or create a new one."
else
  warn "Couldn't confirm the key (HTTP ${CODE:-none}). Continuing anyway; test it with: claude-hack"
fi

# ---------------------------------------------------------------------------
say "3/4  Saving the key"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
( umask 077; printf '%s' "$API_KEY" > "$KEY_FILE" )
unset API_KEY
ok "Saved to $KEY_FILE (readable only by you)"

# Default the hackathon profile to Sonnet (cheaper). Switch anytime with /model.
SETTINGS="$CONFIG_DIR/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  printf '{\n  "model": "sonnet"\n}\n' > "$SETTINGS"
  ok "Default model: Sonnet (use /model to switch to Opus for hard problems)"
fi

# ---------------------------------------------------------------------------
say "4/4  Creating the claude-hack command"
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
# Runs Claude Code on hackathon API credits, isolated from your normal login.
export CLAUDE_CONFIG_DIR="$HOME/.claude-hackathon"
KEY_FILE="$CLAUDE_CONFIG_DIR/api_key"
[[ -s "$KEY_FILE" ]] || { echo "No key at $KEY_FILE. Rerun setup-claude-hack.sh." >&2; exit 1; }
ANTHROPIC_API_KEY="$(cat "$KEY_FILE")"
export ANTHROPIC_API_KEY
CLAUDE_BIN="$HOME/.local/bin/claude"
[[ -x "$CLAUDE_BIN" ]] || CLAUDE_BIN="$(command -v claude)"
exec "$CLAUDE_BIN" "$@"
EOF
chmod 755 "$WRAPPER"
ok "Created $WRAPPER"

# Remove any old claude-hack alias, which would override the new command.
for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if [[ -f "$f" ]] && grep -q "alias claude-hack=" "$f"; then
    cp "$f" "$f.bak-claude-hack"
    grep -v "alias claude-hack=" "$f.bak-claude-hack" > "$f" || true
    ok "Removed an old claude-hack alias from $f (backup: $f.bak-claude-hack)"
  fi
done

# Make sure ~/.local/bin is on PATH in new terminals.
if ! grep -qs '.local/bin' "$RC"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC"
  ok "Added ~/.local/bin to PATH in $RC"
fi

# Enable the repo's pre-push hook (blocks pushes to main) when this script runs from the repo checkout.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
if command -v git >/dev/null 2>&1 && [[ -f "$REPO_DIR/scripts/hooks/pre-push" ]]; then
  git -C "$REPO_DIR" config core.hooksPath scripts/hooks && ok "Enabled the pre-push hook (git config core.hooksPath scripts/hooks)"
fi

# ---------------------------------------------------------------------------
say "Done"
cat <<EOF
  Next:
    1. Open a NEW terminal window (or run: source $RC; unalias claude-hack 2>/dev/null)
    2. cd into your project folder
    3. Run: claude-hack
    4. When asked whether to use the API key, choose Yes
    5. Type /status and check it says it's using the API key ("API Usage Billing")

  Plain 'claude' still uses your normal Claude login.
  For the app's own Claude calls, put the same key in the project's .env
  (ANTHROPIC_API_KEY=...) and make sure .env is in .gitignore.
  Undo: rm -rf ~/.claude-hackathon ~/.local/bin/claude-hack
EOF
