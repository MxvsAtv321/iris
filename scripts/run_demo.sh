#!/bin/sh
# Starts everything the demo needs on the integration laptop, and prints the https link for the phone.
#
#   scripts/run_demo.sh start    brain, Cloudflare tunnel, web app (and the link)
#   scripts/run_demo.sh status   what is running, and the link
#   scripts/run_demo.sh link     just the link
#   scripts/run_demo.sh stop     stop all three
#   scripts/run_demo.sh restart-brain   restart only the brain (after changing .env); the link stays the same
#
# The tunnel is a Cloudflare quick tunnel: no account needed, public, and its address is new every
# time it starts. It dies if the laptop changes network (hotspot to WiFi and back); `status` says so and
# `start` replaces it, with a new address. `start` writes that address into TUNNEL_HOST in the root .env, then builds the web
# app and serves the build, so the phone loads a few bundled files instead of the dev server's hundreds.
# Phones need https for the microphone, which is what the tunnel is for.
#
# Logs and pid files are in brain/.run/ (not committed). The Agentverse agents are separate: scripts/agents.sh.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/brain/.run"
WEB_PORT=4173
BRAIN_PORT=8000
mkdir -p "$RUN"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
host() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$RUN/tunnel.log" 2>/dev/null | tail -1 | sed 's#https://##'; }
# The HTTP status of a URL, or 000. The alarm is a hard stop: looking up the name of a tunnel that no longer exists
# can hang far past curl's own time limit.
answers() {
  code="$(perl -e 'alarm shift; exec @ARGV' "$(( ${2:-3} + 2 ))" curl -s -o /dev/null -m "${2:-3}" -w '%{http_code}' "$1" 2>/dev/null)"
  echo "${code:-000}"
}

# A quick tunnel does not survive the laptop changing networks: cloudflared keeps running and retrying, but
# Cloudflare has forgotten the tunnel ("Tunnel not found"), so its address answers nothing. Only a new tunnel,
# with a new address, fixes that.
tunnel_dead() {
  [ -n "$(host)" ] || return 1
  [ "$(answers "http://127.0.0.1:$WEB_PORT/phone")" = "200" ] || return 1     # the web app is down: not the tunnel's fault
  [ "$(answers "https://$(host)/phone" 6)" = "200" ] && return 1
  sleep 3
  [ "$(answers "https://$(host)/phone" 6)" != "200" ]
}

set_env() {   # set_env KEY VALUE: replace the line in .env, or add it
  if grep -q "^$1=" "$ROOT/.env" 2>/dev/null; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ROOT/.env"
  fi
}

start() {
  [ -f "$ROOT/.env" ] || { echo "no .env at the repo root: copy .env.example and fill it in"; exit 1; }
  command -v cloudflared >/dev/null || { echo "cloudflared is not installed: brew install cloudflared"; exit 1; }

  if alive brain; then echo "brain already running (pid $(cat "$RUN/brain.pid"))"; else
    PY="$ROOT/brain/.venv/bin/uvicorn"; [ -x "$PY" ] || PY=uvicorn
    (cd "$ROOT/brain" || exit 1; nohup "$PY" main:app --host 127.0.0.1 --port $BRAIN_PORT > "$RUN/brain.log" 2>&1 < /dev/null & echo $! > "$RUN/brain.pid")
    echo "started the brain on port $BRAIN_PORT"
  fi

  if alive tunnel && [ -n "$(host)" ] && ! tunnel_dead; then echo "tunnel already running"; else
    if alive tunnel; then
      echo "the tunnel is running but its address no longer works (the network changed); starting a new one"
      kill "$(cat "$RUN/tunnel.pid")" 2>/dev/null; sleep 1
    fi
    : > "$RUN/tunnel.log"
    nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$WEB_PORT" > "$RUN/tunnel.log" 2>&1 < /dev/null &
    echo $! > "$RUN/tunnel.pid"
    printf 'waiting for the tunnel address'
    n=0; while [ -z "$(host)" ] && [ $n -lt 40 ]; do sleep 1; n=$((n + 1)); printf '.'; done; echo
    [ -n "$(host)" ] || { echo "the tunnel gave no address in 40 s; see brain/.run/tunnel.log"; exit 1; }
  fi
  HOST="$(host)"
  set_env TUNNEL_HOST "$HOST"

  if alive web; then kill "$(cat "$RUN/web.pid")" 2>/dev/null; sleep 1; fi   # the web app reads TUNNEL_HOST when it starts
  echo "building the web app..."
  (cd "$ROOT/web" && npm run build > "$RUN/web-build.log" 2>&1) || { echo "the web build failed; see brain/.run/web-build.log"; exit 1; }
  (cd "$ROOT/web" || exit 1; nohup node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port $WEB_PORT --strictPort > "$RUN/web.log" 2>&1 < /dev/null & echo $! > "$RUN/web.pid")

  printf 'waiting for the phone page over https'
  n=0; while [ "$(answers "https://$HOST/phone" 5)" != "200" ] && [ $n -lt 30 ]; do sleep 2; n=$((n + 1)); printf '.'; done; echo
  status
}

status() {
  for p in brain tunnel web; do
    if alive $p; then echo "$p running (pid $(cat "$RUN/$p.pid"))"; else echo "$p not running"; fi
  done
  HOST="$(host)"
  echo "brain answers locally:      $(answers "http://127.0.0.1:$BRAIN_PORT/api/trace")"
  if [ -n "$HOST" ] && alive tunnel; then
    echo "phone page over https:      $(answers "https://$HOST/phone" 6)"
    echo "brain through the tunnel:   $(answers "https://$HOST/api/trace" 6)"
    if tunnel_dead; then
      echo "THE LINK IS DEAD: the tunnel did not survive a network change. Run: scripts/run_demo.sh start (the link will be a new one)"
    fi
    link
  else
    echo "no tunnel address yet"
  fi
}

link() {
  HOST="$(host)"
  [ -n "$HOST" ] || { echo "the tunnel is not running: scripts/run_demo.sh start"; exit 1; }
  echo "Phone:     https://$HOST/phone"
  echo "Dashboard: https://$HOST/dashboard"
  echo "Garden:    https://$HOST/garden?session=judge-01"
}

stop() {
  for p in web tunnel brain; do
    if alive $p; then kill "$(cat "$RUN/$p.pid")" 2>/dev/null && echo "stopped $p"; fi
    rm -f "$RUN/$p.pid"
  done
}

restart_brain() {
  if alive brain; then kill "$(cat "$RUN/brain.pid")" 2>/dev/null; sleep 2; fi
  rm -f "$RUN/brain.pid"
  PY="$ROOT/brain/.venv/bin/uvicorn"; [ -x "$PY" ] || PY=uvicorn
  (cd "$ROOT/brain" || exit 1; nohup "$PY" main:app --host 127.0.0.1 --port $BRAIN_PORT > "$RUN/brain.log" 2>&1 < /dev/null & echo $! > "$RUN/brain.pid")
  n=0; while [ "$(answers "http://127.0.0.1:$BRAIN_PORT/api/trace")" != "200" ] && [ $n -lt 20 ]; do sleep 1; n=$((n + 1)); done
  echo "brain restarted (pid $(cat "$RUN/brain.pid")); it answers: $(answers "http://127.0.0.1:$BRAIN_PORT/api/trace")"
}

case "${1:-status}" in
  start) start ;;
  restart-brain) restart_brain ;;
  status) status ;;
  link) link ;;
  stop) stop ;;
  *) echo "usage: scripts/run_demo.sh start|status|link|stop|restart-brain"; exit 1 ;;
esac
