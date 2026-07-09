#!/usr/bin/env bash
#
# Aries AI — one-line self-host installer.
#
#   curl -fsSL https://raw.githubusercontent.com/DeliciousHouse/aries-app/master/install.sh | bash
#
# What it does:
#   1. Checks prerequisites (Docker + Compose v2, openssl, curl).
#   2. Fetches the repo (git clone, or a tarball when git is missing).
#   3. Generates a minimal .env with random secrets (preserved on re-run).
#   4. Brings up the stack: aries-app + sidecars + bundled PostgreSQL, and
#      (unless --no-hermes) a bundled Hermes execution gateway.
#   5. Waits for the app to report healthy and prints next steps.
#
# Idempotent: safe to re-run in the same --dir (updates the checkout, keeps
# your .env, restarts services on the new image).
#
# Flags:
#   --dir DIR          Install directory (default: ./aries-app)
#   --ref REF          Git branch/tag to install (default: master)
#   --build            Build the image locally instead of pulling from GHCR
#   --no-hermes        Skip the bundled Hermes gateway (no content generation)
#   --domain URL       Public origin for the app (default: http://localhost:3000)
#   --llm-provider P   openrouter | anthropic | openai (default: openrouter)
#   --llm-key KEY      LLM API key for Hermes (or env ARIES_LLM_API_KEY)
#   --email-from S     From header for transactional email
#   -y, --yes          Non-interactive: never prompt, use flags/defaults
set -euo pipefail

REPO_SLUG="DeliciousHouse/aries-app"
DEFAULT_IMAGE="ghcr.io/delicioushouse/aries-app:latest"

INSTALL_DIR="./aries-app"
GIT_REF="master"
BUILD_LOCAL=0
WITH_HERMES=1
DOMAIN="http://localhost:3000"
LLM_PROVIDER="openrouter"
LLM_KEY="${ARIES_LLM_API_KEY:-}"
EMAIL_FROM_VALUE="Aries AI <onboarding@resend.dev>"
ASSUME_YES=0
APP_PORT=3000
HEALTH_TIMEOUT_SECS=180

log()  { printf '\033[1;36m[aries-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aries-install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[aries-install]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,28p' "$0" 2>/dev/null || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)          INSTALL_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --ref)          GIT_REF="${2:?--ref needs a value}"; shift 2 ;;
    --build)        BUILD_LOCAL=1; shift ;;
    --no-hermes)    WITH_HERMES=0; shift ;;
    --domain)       DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --llm-provider) LLM_PROVIDER="${2:?--llm-provider needs a value}"; shift 2 ;;
    --llm-key)      LLM_KEY="${2:?--llm-key needs a value}"; shift 2 ;;
    --email-from)   EMAIL_FROM_VALUE="${2:?--email-from needs a value}"; shift 2 ;;
    -y|--yes)       ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown flag: $1 (see --help)" ;;
  esac
done

case "$LLM_PROVIDER" in
  openrouter|anthropic|openai) ;;
  *) die "--llm-provider must be openrouter, anthropic, or openai" ;;
esac

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required. Install it and re-run."
command -v openssl >/dev/null 2>&1 || die "openssl is required (used to generate secrets). Install it and re-run."
command -v docker >/dev/null 2>&1 || die "Docker is required. Install it: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Docker daemon is not reachable. Start Docker (or add your user to the docker group) and re-run."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose', not 'docker-compose'). See https://docs.docker.com/compose/install/"

# Interactive prompts only when a real terminal is attached. Under
# `curl | bash` stdin is the pipe, so read from /dev/tty when available.
INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  INTERACTIVE=1
fi

prompt() { # prompt <question> <default> -> stdout
  local question="$1" default="$2" answer=""
  if [ "$INTERACTIVE" -eq 1 ]; then
    printf '%s [%s]: ' "$question" "$default" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
  fi
  printf '%s' "${answer:-$default}"
}

# ---------------------------------------------------------------------------
# 2. Fetch source
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Existing checkout found in $INSTALL_DIR — updating to $GIT_REF."
  git -C "$INSTALL_DIR" fetch origin "$GIT_REF"
  git -C "$INSTALL_DIR" checkout "$GIT_REF"
  git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_REF" || warn "pull --ff-only failed (local commits?); continuing with the current checkout."
elif [ -f "$INSTALL_DIR/docker-compose.selfhost.yml" ]; then
  log "Existing non-git install found in $INSTALL_DIR — reusing it as-is."
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  die "$INSTALL_DIR exists, is not empty, and is not an Aries install (no .git or docker-compose.selfhost.yml). Pick a different --dir or clear it out first."
elif command -v git >/dev/null 2>&1; then
  log "Cloning $REPO_SLUG ($GIT_REF) into $INSTALL_DIR."
  git clone --depth 1 --branch "$GIT_REF" "https://github.com/$REPO_SLUG.git" "$INSTALL_DIR"
else
  log "git not found — downloading tarball of $GIT_REF instead."
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "https://github.com/$REPO_SLUG/archive/$GIT_REF.tar.gz" \
    | tar -xz --strip-components=1 -C "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
INSTALL_DIR="$(pwd)" # absolute from here on (compose bind mounts need it)
case "$INSTALL_DIR" in
  *[[:space:]]*) die "install path '$INSTALL_DIR' contains whitespace, which breaks the compose bind-mount paths written to .env. Re-run with a whitespace-free --dir." ;;
esac

# ---------------------------------------------------------------------------
# 3. Prompts (TTY only) + Hermes degrade
# ---------------------------------------------------------------------------
if [ "$INTERACTIVE" -eq 1 ] && [ ! -f .env ]; then
  DOMAIN="$(prompt 'Public URL for this install' "$DOMAIN")"
  if [ "$WITH_HERMES" -eq 1 ] && [ -z "$LLM_KEY" ]; then
    LLM_PROVIDER="$(prompt 'LLM provider for content generation (openrouter/anthropic/openai)' "$LLM_PROVIDER")"
    LLM_KEY="$(prompt "API key for $LLM_PROVIDER (empty = skip Hermes for now)" '')"
  fi
fi

# On re-runs the LLM key usually lives in the preserved .env, not a flag —
# honor it so an existing with-Hermes install never silently degrades.
if [ "$WITH_HERMES" -eq 1 ] && [ -z "$LLM_KEY" ] && [ -f .env ] \
  && grep -qE '^(OPENROUTER|ANTHROPIC|OPENAI)_API_KEY=.+' .env; then
  LLM_KEY="from-env-file"
fi

if [ "$WITH_HERMES" -eq 1 ] && [ -z "$LLM_KEY" ]; then
  warn "No LLM API key provided — installing WITHOUT the Hermes gateway."
  warn "The dashboard, auth, and scheduling all work; content generation stays off"
  warn "until you add a key to .env and re-run with the hermes profile."
  WITH_HERMES=0
fi

# ---------------------------------------------------------------------------
# 4. Generate .env (only when absent — re-runs keep your config)
# ---------------------------------------------------------------------------
# Upsert NAME=VALUE in .env (used to persist an explicit --llm-key on re-run).
set_env_var() {
  local name="$1" value="$2"
  if grep -qE "^${name}=" .env; then
    awk -v n="$name" -v v="$value" 'index($0, n"=") == 1 { print n "=" v; next } { print }' .env > .env.tmp \
      && mv .env.tmp .env && chmod 600 .env
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
}

if [ -f .env ]; then
  log "Keeping existing .env (delete it to regenerate)."
  # An explicit --llm-key on a re-run must land in the preserved .env, or the
  # hermes profile would start with the stale (possibly empty) credentials —
  # this is exactly the "enable Hermes later" path the docs advertise.
  if [ -n "$LLM_KEY" ] && [ "$LLM_KEY" != "from-env-file" ]; then
    case "$LLM_PROVIDER" in
      openrouter) set_env_var OPENROUTER_API_KEY "$LLM_KEY" ;;
      anthropic)  set_env_var ANTHROPIC_API_KEY "$LLM_KEY" ;;
      openai)     set_env_var OPENAI_API_KEY "$LLM_KEY" ;;
    esac
    log "Updated ${LLM_PROVIDER} API key in .env."
  fi
else
  log "Generating .env with fresh random secrets."
  if [ "$BUILD_LOCAL" -eq 1 ]; then
    IMAGE_LINE="ARIES_APP_IMAGE=aries-app:local"
  else
    IMAGE_LINE="ARIES_APP_IMAGE=$DEFAULT_IMAGE"
  fi
  LLM_KEY_LINES=$'OPENROUTER_API_KEY=\nANTHROPIC_API_KEY=\nOPENAI_API_KEY='
  if [ -n "$LLM_KEY" ]; then
    case "$LLM_PROVIDER" in
      openrouter) LLM_KEY_LINES="OPENROUTER_API_KEY=$LLM_KEY"$'\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=' ;;
      anthropic)  LLM_KEY_LINES=$'OPENROUTER_API_KEY=\n'"ANTHROPIC_API_KEY=$LLM_KEY"$'\nOPENAI_API_KEY=' ;;
      openai)     LLM_KEY_LINES=$'OPENROUTER_API_KEY=\nANTHROPIC_API_KEY=\n'"OPENAI_API_KEY=$LLM_KEY" ;;
    esac
  fi
  cat > .env <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Every knob is documented in .env.example — this file is the minimal
# self-host set. Secrets below were generated locally; keep this file private.

$IMAGE_LINE
PORT=$APP_PORT

# Public origin
APP_BASE_URL=$DOMAIN
NEXTAUTH_URL=$DOMAIN
AUTH_URL=$DOMAIN
AUTH_TRUST_HOST=true

# Secrets (generated)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
INTERNAL_API_SECRET=$(openssl rand -hex 32)
OAUTH_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Bundled PostgreSQL (docker-compose.selfhost.yml)
DB_HOST=postgres
DB_PORT=5432
DB_USER=aries
DB_PASSWORD=$(openssl rand -hex 24)
DB_NAME=aries

# Data + Hermes media paths (host binds; must be absolute)
ARIES_SHARED_DATA_ROOT=$INSTALL_DIR/data
ARIES_HOST_ARTIFACT_OUTPUT_DIR=$INSTALL_DIR/hermes-data/output
HERMES_DATA_DIR=$INSTALL_DIR/hermes-data
HERMES_IMAGE_CACHE_DIR=$INSTALL_DIR/hermes-data/cache/images
HERMES_VIDEO_CACHE_DIR=$INSTALL_DIR/hermes-data/cache/videos

# Bundled single-gateway Hermes. All profile routes point at the same
# gateway (the base compose defaults point at host ports that do not exist
# in this stack, so these overrides are required).
HERMES_GATEWAY_URL=http://hermes:8642
HERMES_RESEARCH_GATEWAY_URL=http://hermes:8642
HERMES_STRATEGIST_GATEWAY_URL=http://hermes:8642
HERMES_CONTENT_GATEWAY_URL=http://hermes:8642
HERMES_API_SERVER_KEY=$(openssl rand -hex 32)
HERMES_SESSION_KEY=main

# LLM provider key for Hermes ($LLM_PROVIDER)
$LLM_KEY_LINES

# Transactional email (optional — password reset). onboarding@resend.dev is
# Resend's shared sandbox sender; set RESEND_API_KEY to enable sending.
EMAIL_FROM=$EMAIL_FROM_VALUE
RESEND_API_KEY=

# Optional integrations — blank disables them (and silences compose warnings).
GEMINI_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
META_ACCESS_TOKEN=
META_AD_ACCOUNT_ID=
META_APP_ID=
META_APP_SECRET=
META_PAGE_ID=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
X_CLIENT_ID=
X_CLIENT_SECRET=
EOF
  chmod 600 .env
fi

APP_PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2 || true)"
APP_PORT="${APP_PORT:-3000}"

# ---------------------------------------------------------------------------
# 5. Data directories
# ---------------------------------------------------------------------------
mkdir -p data \
  hermes-data/cache/images \
  hermes-data/cache/videos \
  hermes-data/output \
  hermes-data/skills
# Seed the marketing agent skills into the Hermes data dir (best-effort; only
# when the target is still empty so a re-run never clobbers gateway state).
if [ -d skills ] && [ -z "$(ls -A hermes-data/skills 2>/dev/null)" ]; then
  cp -R skills/. hermes-data/skills/ || warn "could not seed skills/ into hermes-data (continuing)"
fi
# The app container runs as uid 1004 and only needs read access to the caches.
chmod -R a+rX hermes-data data 2>/dev/null || true

# ---------------------------------------------------------------------------
# 6. Network + compose up
# ---------------------------------------------------------------------------
docker network create docker-stack >/dev/null 2>&1 || true

COMPOSE=(docker compose --env-file .env -f docker-compose.yml -f docker-compose.selfhost.yml)
if [ "$WITH_HERMES" -eq 1 ]; then
  COMPOSE+=(--profile hermes)
fi

if [ "$BUILD_LOCAL" -eq 1 ]; then
  log "Building the app image locally (this takes several minutes)."
  "${COMPOSE[@]}" build aries-app
else
  log "Pulling images (app image: $DEFAULT_IMAGE)."
  if ! "${COMPOSE[@]}" pull --ignore-buildable 2>/dev/null && ! "${COMPOSE[@]}" pull; then
    warn "Pull failed — falling back to a local build."
    BUILD_LOCAL=1
    sed -i.bak "s|^ARIES_APP_IMAGE=.*|ARIES_APP_IMAGE=aries-app:local|" .env && rm -f .env.bak
    "${COMPOSE[@]}" build aries-app
  fi
fi

log "Starting the stack."
if [ "$BUILD_LOCAL" -eq 1 ]; then
  "${COMPOSE[@]}" up -d
else
  "${COMPOSE[@]}" up -d --no-build
fi

# ---------------------------------------------------------------------------
# 7. Health wait
# ---------------------------------------------------------------------------
log "Waiting for the app to become healthy (up to ${HEALTH_TIMEOUT_SECS}s)."
deadline=$((SECONDS + HEALTH_TIMEOUT_SECS))
healthy=0
while [ $SECONDS -lt $deadline ]; do
  if curl -fsS "http://localhost:$APP_PORT/api/health/db" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  warn "The app did not become healthy within ${HEALTH_TIMEOUT_SECS}s."
  warn "Inspect logs with:"
  warn "  cd $INSTALL_DIR && ${COMPOSE[*]} logs aries-app postgres"
  exit 1
fi

# ---------------------------------------------------------------------------
# 8. Next steps
# ---------------------------------------------------------------------------
log "Aries AI is up."
cat <<EOF

  Open:            $DOMAIN/signup   (creating an account auto-provisions your workspace)
  Config:          $INSTALL_DIR/.env
  Logs:            cd $INSTALL_DIR && ${COMPOSE[*]} logs -f aries-app
  Upgrade:         re-run this installer, or:
                   cd $INSTALL_DIR && git pull && ${COMPOSE[*]} pull && ${COMPOSE[*]} up -d

EOF
if [ "$WITH_HERMES" -eq 1 ]; then
  cat <<EOF
  Hermes gateway:  running in-network at http://hermes:8642 (data in $INSTALL_DIR/hermes-data).
                   If generation runs fail, finish the gateway's model setup interactively:
                     cd $INSTALL_DIR && ${COMPOSE[*]} run --rm -it hermes setup
                     cd $INSTALL_DIR && ${COMPOSE[*]} restart hermes
EOF
else
  cat <<EOF
  Hermes gateway:  NOT installed (no LLM key / --no-hermes). Dashboard, auth and
                   scheduling work; content generation is disabled. To enable later:
                   add your provider key to .env, then re-run:
                     curl -fsSL https://raw.githubusercontent.com/$REPO_SLUG/master/install.sh | bash -s -- --dir $INSTALL_DIR --llm-key YOUR_KEY
EOF
fi
cat <<EOF
  Optional:        connect Meta/Composio/Slack/Resend by filling the matching
                   keys in .env and re-running '${COMPOSE[*]} up -d'.
                   Full reference: .env.example and docs/SELF_HOSTING.md

EOF
