#!/bin/bash

# start-system.sh
# Tears down and brings back up the API, Frontend, a single local reverse
# proxy in front of both, and one ngrok tunnel onto that proxy.
#
# Single origin, not two: the SDK's apiBaseUrl and webviewBaseUrl are the same
# host now (path-routed by dev-proxy.mjs), so there is exactly one tunnel that
# can go down instead of two independent ones failing independently.

set -e

PROJECT_DIR="/Users/hassanrashid/Desktop/git/mindstorm/crm/app"
PROXY_LOG="$PROJECT_DIR/logs/dev_proxy.log"
TUNNEL_LOG="$PROJECT_DIR/logs/tunnel.log"
API_LOG="$PROJECT_DIR/logs/server_api.log"
WEB_LOG="$PROJECT_DIR/logs/server_web.log"

API_PORT=4000
WEB_PORT=5173
PROXY_PORT=8787
NGROK_API="http://127.0.0.1:4040/api/tunnels"

mkdir -p "$PROJECT_DIR/logs"

echo "🛑 Cleaning up previous processes..."
pkill -f "cloudflared" 2>/dev/null || true
pkill -f "ssh -o StrictHostKeyChecking=no -R 80:localhost" 2>/dev/null || true
pkill -f "ngrok http" 2>/dev/null || true
pkill -f "dev-proxy.mjs" 2>/dev/null || true

# pnpm exec-replaces its own process image, so a script it spawns never carries
# "@support/api dev" / "@support/web serve:built" in its argv — only the
# underlying command (`node --watch ... src/server.ts`, `vite preview --port
# 5173 ...`). Matching on the pnpm invocation text, as this used to, never
# actually killed anything, which is how a stale API server from a previous
# run kept running for days and silently served requests instead of the one
# started below.
pkill -f "node --watch --experimental-strip-types src/server.ts" 2>/dev/null || true
pkill -f "vite preview --port $WEB_PORT" 2>/dev/null || true

# Belt and suspenders: kill whatever currently holds our ports, AND its parent.
# `node --watch` runs as a supervisor/child pair; killing only the child (the
# port holder) leaves the supervisor alive, and it immediately respawns a
# replacement child that reclaims the port — so a plain port-kill alone lets a
# stale watcher survive this cleanup even when the pattern match above does
# not, e.g. after a future Node/pnpm version changes how the command line
# looks again.
kill_port() {
  local port="$1"
  for pid in $(lsof -ti:"$port" 2>/dev/null); do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    kill -9 "$pid" 2>/dev/null || true
    if [ -n "$ppid" ] && [ "$ppid" != "1" ]; then
      kill -9 "$ppid" 2>/dev/null || true
    fi
  done
}
kill_port "$API_PORT"
kill_port "$WEB_PORT"
kill_port "$PROXY_PORT"

sleep 2

echo "🔀 Starting single-origin dev proxy (:$PROXY_PORT -> api:$API_PORT, web:$WEB_PORT)..."
> "$PROXY_LOG"
DEV_PROXY_PORT=$PROXY_PORT API_PORT=$API_PORT WEB_PORT=$WEB_PORT \
  nohup node "$PROJECT_DIR/scripts/dev-proxy.mjs" > "$PROXY_LOG" 2>&1 &

for i in {1..10}; do
  if lsof -ti:$PROXY_PORT >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! lsof -ti:$PROXY_PORT >/dev/null 2>&1; then
  echo "❌ dev-proxy failed to start. Check $PROXY_LOG"
  exit 1
fi

echo "🌐 Starting ngrok tunnel..."
> "$TUNNEL_LOG"
nohup ngrok http $PROXY_PORT --log=stdout > "$TUNNEL_LOG" 2>&1 &

TUNNEL_URL=""
for i in {1..20}; do
  TUNNEL_URL=$(curl -s "$NGROK_API" | grep -o '"public_url":"https://[^"]*"' | head -n 1 | sed -E 's/.*"(https:\/\/[^"]*)"/\1/')
  if [ -n "$TUNNEL_URL" ]; then break; fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get ngrok tunnel URL after retries. Check $TUNNEL_LOG"
  exit 1
fi
echo "✅ Tunnel: $TUNNEL_URL"

echo "📝 Updating environment configurations..."
# Update backend .env
if grep -q "^SURFACE_ORIGINS=" "$PROJECT_DIR/.env"; then
    sed -i '' "s|^SURFACE_ORIGINS=.*|SURFACE_ORIGINS=http://localhost:5173,$TUNNEL_URL|" "$PROJECT_DIR/.env"
else
    echo "SURFACE_ORIGINS=http://localhost:5173,$TUNNEL_URL" >> "$PROJECT_DIR/.env"
fi

# Update frontend .env — same origin as the SDK's apiBaseUrl below, since the
# proxy fronts both. Baked in at build time by serve:built, so this must be
# written before that runs.
if grep -q "^VITE_API_BASE_URL=" "$PROJECT_DIR/frontend/.env"; then
    sed -i '' "s|^VITE_API_BASE_URL=.*|VITE_API_BASE_URL=$TUNNEL_URL|" "$PROJECT_DIR/frontend/.env"
else
    echo "VITE_API_BASE_URL=$TUNNEL_URL" >> "$PROJECT_DIR/frontend/.env"
fi

echo "🎮 Updating Unity SDK configuration..."
SDK_CONFIG="/Users/hassanrashid/Desktop/git/mindstorm/crm/SDK/CRM/Assets/Support/Config/SupportSdkConfig.asset"
if [ -f "$SDK_CONFIG" ]; then
    # Same host for both now — apiBaseUrl and webviewBaseUrl differ only by path.
    sed -i '' "s|apiBaseUrl: .*|apiBaseUrl: $TUNNEL_URL|" "$SDK_CONFIG"
    sed -i '' "s|webviewBaseUrl: .*|webviewBaseUrl: $TUNNEL_URL/embed/support|" "$SDK_CONFIG"
    echo "✅ Unity SDK config updated."
else
    echo "⚠️ Unity SDK config not found at $SDK_CONFIG"
fi

echo "🚀 Starting backend API server..."
cd "$PROJECT_DIR" || exit
nohup pnpm --filter @support/api dev > "$API_LOG" 2>&1 &

echo "🚀 Building and starting frontend server..."
nohup pnpm --filter @support/web serve:built > "$WEB_LOG" 2>&1 &

echo "🎉 All services have been restarted successfully!"
echo "📂 Tailing live logs (Press Ctrl+C to exit log view)..."
echo "--------------------------------------------------------"

# Tail all logs simultaneously
tail -f "$API_LOG" "$WEB_LOG" "$PROXY_LOG" "$TUNNEL_LOG"
