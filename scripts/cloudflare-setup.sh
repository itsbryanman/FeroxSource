#!/usr/bin/env bash
# Deploys the Ferox bridge Worker and writes .env.cloud for the runner.
# Needs: Workers Paid plan with Artifacts enabled.
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG=cloudflare/wrangler.jsonc

echo "== checking wrangler login"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

echo "== typecheck"
npm run -s check:cloudflare

echo "== deploy"
DEPLOY_LOG=$(npx wrangler deploy -c "$CONFIG" 2>&1 | tee /dev/stderr)
URL=$(printf '%s\n' "$DEPLOY_LOG" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)
if [[ -z "$URL" ]]; then
  read -rp "couldn't find the workers.dev URL in the deploy output. paste it: " URL
fi

echo "== secrets"
if [[ -f .env.cloud ]] && grep -q FEROX_BRIDGE_TOKEN .env.cloud; then
  RUNNER_SECRET=$(grep FEROX_BRIDGE_TOKEN .env.cloud | cut -d= -f2-)
  echo "reusing runner secret from .env.cloud"
else
  RUNNER_SECRET=$(openssl rand -hex 32)
fi
printf '%s' "$RUNNER_SECRET" | npx wrangler secret put RUNNER_SECRET -c "$CONFIG" >/dev/null

umask 077
cat > .env.cloud <<ENV
FEROX_BRIDGE_URL=$URL
FEROX_BRIDGE_TOKEN=$RUNNER_SECRET
ENV
echo "wrote .env.cloud (gitignored)"

echo "== health"
sleep 3
curl -fsS "$URL/health" && echo
echo
echo "next: npm run cloud:smoke"
