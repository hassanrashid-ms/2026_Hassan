#!/usr/bin/env bash
# Proves the SDK seam end to end against a running API.
#   SEED_SECRET=sk_demo-game.xxx ./scripts/verify-seam.sh
set -euo pipefail

API="${API_BASE_URL:-http://localhost:4000}"
SLUG="${WORKSPACE_SLUG:-demo-game}"
: "${SEED_SECRET:?Set SEED_SECRET to the workspace secret printed by db:seed}"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
uuid() { node -e 'console.log(crypto.randomUUID())'; }

echo "1. minting a player token"
TOKEN=$(curl -sf -X POST "$API/auth/player-token" \
  -H "Authorization: Bearer $SEED_SECRET" -H 'Content-Type: application/json' \
  -d '{"external_player_id":"UserId7661"}' | json 'o.token')
[ -n "$TOKEN" ] || { echo "FAIL: no token"; exit 1; }

SESSION=$(uuid)
HDRS=(-H "Authorization: Bearer $TOKEN" -H "X-Support-Workspace: $SLUG"
      -H 'X-Support-Sdk: 1.0.2' -H 'X-Support-Client-Version: 6.2.01'
      -H 'Content-Type: application/json')

echo "2. starting session $SESSION"
curl -sf -X POST "$API/sdk/sessions/start" "${HDRS[@]}" -H "Idempotency-Key: $(uuid)" \
  -d "{\"session_id\":\"$SESSION\",\"entry_point\":\"settings_menu\",
       \"started_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
       \"snapshot\":{\"player_id\":\"UserId7661\",\"platform\":\"ios\",\"os_version\":\"26.5.2\",
                     \"device_model\":\"iPhone 13 Pro Max\",\"locale\":\"en-GB\",
                     \"client_version\":\"6.2.01\",\"player_level\":34,\"total_spend\":0,
                     \"spend_tier\":\"non-payer\",\"extra\":{\"ab_bucket\":\"B\"}}}" >/dev/null

echo "3. redelivering the same start (the Outbox does this)"
curl -sf -X POST "$API/sdk/sessions/start" "${HDRS[@]}" -H "Idempotency-Key: $(uuid)" \
  -d "{\"session_id\":\"$SESSION\",\"entry_point\":\"settings_menu\",\"snapshot\":{}}" >/dev/null

echo "4. bootstrap as the web surface would"
curl -sf "$API/surface/bootstrap?session_id=$SESSION" -H "Authorization: Bearer $TOKEN" \
  | json 'JSON.stringify({availability:o.player_state.availability,
                          declared:Object.keys(o.player_state.declared).length,
                          raw:o.player_state.raw},null,2)'

echo "5. article_read, unread, incident, end"
curl -sf -X POST "$API/surface/events/article_read" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"session_id\":\"$SESSION\",\"article_id\":\"a_123\"}" >/dev/null
curl -sf "$API/sdk/unread" "${HDRS[@]}" | json 'JSON.stringify(o)'
curl -sf -X POST "$API/sdk/incidents" "${HDRS[@]}" \
  -d "{\"incident_id\":\"$(uuid)\",\"session_id\":\"$SESSION\",\"kind\":\"token_timeout\",
       \"detail\":\"5s elapsed, no response\",\"sdk_version\":\"1.0.2\",\"client_version\":\"6.2.01\"}" >/dev/null
curl -sf -X POST "$API/sdk/sessions/end" "${HDRS[@]}" \
  -d "{\"session_id\":\"$SESSION\",\"duration_ms\":184200,\"conversation_created\":false,
       \"articles_read\":[\"a_123\"]}" >/dev/null

cat <<EOF

Now confirm in psql:
  docker compose exec postgres psql -U support_owner -d support -c "
    select type, count(*) from event where session_id = '$SESSION' group by type order by type;"

Expected exactly:
  article_read   1
  sdk_incident   1
  session_end    1
  session_start  1     <- one, not two: the redelivery appended no second event
EOF
