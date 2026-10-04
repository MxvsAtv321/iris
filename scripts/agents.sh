#!/bin/sh
# Starts, stops or lists the three Iris agents on Agentverse. Each is one process that has to stay
# running to answer. Logs and pid files go in brain/.agents/ (not committed).
#
#   scripts/agents.sh start | stop | status
cd "$(dirname "$0")/../brain" || exit 1
PY=.venv/bin/python
[ -x "$PY" ] || PY=python3
mkdir -p .agents
case "${1:-status}" in
  start)
    for a in agent agent_memory agent_gate; do
      if [ -f ".agents/$a.pid" ] && kill -0 "$(cat ".agents/$a.pid")" 2>/dev/null; then
        echo "$a is already running (pid $(cat ".agents/$a.pid"))"
      else
        nohup "$PY" "$a.py" > ".agents/$a.log" 2>&1 &
        echo $! > ".agents/$a.pid"
        echo "started $a (pid $!), log brain/.agents/$a.log"
      fi
    done ;;
  stop)
    for a in agent agent_memory agent_gate; do
      [ -f ".agents/$a.pid" ] && kill "$(cat ".agents/$a.pid")" 2>/dev/null && echo "stopped $a"
      rm -f ".agents/$a.pid"
    done ;;
  status)
    for a in agent agent_memory agent_gate; do
      if [ -f ".agents/$a.pid" ] && kill -0 "$(cat ".agents/$a.pid")" 2>/dev/null; then
        echo "$a running (pid $(cat ".agents/$a.pid")): $(grep -o 'registered on Agentverse as .*' ".agents/$a.log" | tail -1)"
      else
        echo "$a not running"
      fi
    done ;;
  *) echo "usage: scripts/agents.sh start|stop|status"; exit 1 ;;
esac
