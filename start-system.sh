#!/bin/bash

# start-system.sh
# Automates tearing down and bringing back up the API, Frontend, and Cloudflare tunnels.

PROJECT_DIR="/Users/hassanrashid/Desktop/git/mindstorm/crm/app"
BACKEND_TUNNEL_LOG="$PROJECT_DIR/logs/tunnel_api.log"
FRONTEND_TUNNEL_LOG="$PROJECT_DIR/logs/tunnel_web.log"
API_LOG="$PROJECT_DIR/logs/server_api.log"
WEB_LOG="$PROJECT_DIR/logs/server_web.log"

# Ensure logs directory exists
mkdir -p "$PROJECT_DIR/logs"

echo "🛑 Cleaning up previous processes..."
pkill -f "cloudflared"
pkill -f "ssh -o StrictHostKeyChecking=no -R 80:localhost"
pkill -f "@support/api dev"
pkill -f "@support/web serve:built"

# Explicitly kill anything holding our ports to prevent "Port already in use" errors
lsof -ti:4000 | xargs kill -9 2>/dev/null || true
lsof -ti:5173 | xargs kill -9 2>/dev/null || true

sleep 2

function start_tunnel {
    local PORT=$1
    local LOG_FILE=$2
    local MAX_RETRIES=3
    local RETRY_COUNT=0
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        # Clear log
        > "$LOG_FILE"
        nohup ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=no -R 80:localhost:$PORT nokey@localhost.run > "$LOG_FILE" 2>&1 &
        local TUNNEL_PID=$!
        
        # Wait up to 15 seconds for URL
        for i in {1..15}; do
            local URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.lhr\.life' "$LOG_FILE" | head -n 1)
            if [ -n "$URL" ]; then
                echo "$URL"
                return 0
            fi
            sleep 1
        done
        
        # If we got here, it timed out. Kill it and try again.
        kill $TUNNEL_PID 2>/dev/null
        RETRY_COUNT=$((RETRY_COUNT+1))
    done
    return 1
}

echo "🌐 Starting Cloudflare tunnels (this might retry if Cloudflare times out)..."

API_TUNNEL_URL=$(start_tunnel 4000 "$BACKEND_TUNNEL_LOG")
if [ -z "$API_TUNNEL_URL" ]; then
    echo "❌ Failed to get API tunnel URL after retries. Check $BACKEND_TUNNEL_LOG"
    exit 1
fi
echo "✅ API Tunnel: $API_TUNNEL_URL"

WEB_TUNNEL_URL=$(start_tunnel 5173 "$FRONTEND_TUNNEL_LOG")
if [ -z "$WEB_TUNNEL_URL" ]; then
    echo "❌ Failed to get Web tunnel URL after retries. Check $FRONTEND_TUNNEL_LOG"
    exit 1
fi
echo "✅ Web Tunnel: $WEB_TUNNEL_URL"

echo "📝 Updating environment configurations..."
# Update backend .env
if grep -q "^SURFACE_ORIGINS=" "$PROJECT_DIR/.env"; then
    sed -i '' "s|^SURFACE_ORIGINS=.*|SURFACE_ORIGINS=http://localhost:5173,$WEB_TUNNEL_URL|" "$PROJECT_DIR/.env"
else
    echo "SURFACE_ORIGINS=http://localhost:5173,$WEB_TUNNEL_URL" >> "$PROJECT_DIR/.env"
fi

# Update frontend .env
if grep -q "^VITE_API_BASE_URL=" "$PROJECT_DIR/frontend/.env"; then
    sed -i '' "s|^VITE_API_BASE_URL=.*|VITE_API_BASE_URL=$API_TUNNEL_URL|" "$PROJECT_DIR/frontend/.env"
else
    echo "VITE_API_BASE_URL=$API_TUNNEL_URL" >> "$PROJECT_DIR/frontend/.env"
fi

echo "🎮 Updating Unity SDK configurations..."
SDK_CONFIG="/Users/hassanrashid/Desktop/git/mindstorm/crm/SDK/CRM/Assets/Support/Config/SupportSdkConfig.asset"
if [ -f "$SDK_CONFIG" ]; then
    sed -i '' "s|apiBaseUrl: .*|apiBaseUrl: $API_TUNNEL_URL|" "$SDK_CONFIG"
    sed -i '' "s|webviewBaseUrl: .*|webviewBaseUrl: $WEB_TUNNEL_URL/embed/support|" "$SDK_CONFIG"
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

# Tail both logs simultaneously
tail -f "$API_LOG" "$WEB_LOG"

