#!/bin/sh
# Use a ComfyUI that runs on another machine as if it were local.
#
# LU on macOS only connects to ComfyUI (it never starts one) and looks for it
# on 127.0.0.1:8188 by default, so an SSH tunnel to a ComfyUI that listens on
# the remote machine's loopback needs no change in LU at all. The remote
# ComfyUI stays on its loopback: nothing is exposed beyond the SSH session.
#
# On Windows/Linux LU would take the tunnel for a local ComfyUI and offer
# Start/Install; there, set the remote host in Settings → ComfyUI instead.
#
# Usage:
#   comfy-tunnel.sh SSH_HOST [REMOTE_PORT] [LOCAL_PORT]          # foreground, reconnects
#   comfy-tunnel.sh --once SSH_HOST                              # foreground, no reconnect
#   comfy-tunnel.sh install SSH_HOST [REMOTE_PORT] [LOCAL_PORT]  # macOS: always-on LaunchAgent
#   comfy-tunnel.sh install --dry-run SSH_HOST                   # print the LaunchAgent only
#   comfy-tunnel.sh status                                       # agent state, port, last log lines
#   comfy-tunnel.sh uninstall                                    # stop and remove the agent
#
# SSH_HOST is anything `ssh` accepts (an alias from ~/.ssh/config, user@host).
# Ports default to 8188 on both ends. The LaunchAgent starts at login and
# launchd reopens the tunnel whenever it drops; it needs key-based SSH (no
# password prompt in the background). Log: ~/Library/Logs/lu-comfy-tunnel.log
set -eu

LABEL="lu.comfy-tunnel"
AGENT_BIN="$HOME/.local/bin/lu-comfy-tunnel"
AGENT_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENT_LOG="$HOME/Library/Logs/lu-comfy-tunnel.log"

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

check_port() {
  case "$1" in
    ''|*[!0-9]*) echo "Port must be a number, got '$1'" >&2; exit 64 ;;
  esac
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

agent_plist() {
  host="$1"; remote_port="$2"; local_port="$3"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$(xml_escape "$AGENT_BIN")</string>
    <string>--once</string>
    <string>--batch</string>
    <string>$(xml_escape "$host")</string>
    <string>$remote_port</string>
    <string>$local_port</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$AGENT_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$AGENT_LOG")</string>
</dict>
</plist>
EOF
}

install_agent() {
  dry_run=0
  if [ "${1:-}" = "--dry-run" ]; then dry_run=1; shift; fi
  host="${1:-}"
  remote_port="${2:-8188}"
  local_port="${3:-8188}"
  [ -n "$host" ] || { echo "install needs SSH_HOST" >&2; exit 64; }
  check_port "$remote_port"; check_port "$local_port"
  if [ "$dry_run" -eq 1 ]; then
    agent_plist "$host" "$remote_port" "$local_port"
    return 0
  fi
  [ "$(uname -s)" = "Darwin" ] || { echo "install uses launchd (macOS only)." >&2; exit 69; }
  # The agent cannot answer a password or host-key prompt: prove key login first.
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" true >/dev/null 2>&1; then
    echo "ssh $host does not log in without a prompt. Run 'ssh $host' once (accept the host key, use a key)," >&2
    echo "then install again." >&2
    exit 69
  fi
  mkdir -p "$(dirname "$AGENT_BIN")" "$(dirname "$AGENT_PLIST")" "$(dirname "$AGENT_LOG")"
  cp "$0" "$AGENT_BIN"
  chmod 755 "$AGENT_BIN"
  agent_plist "$host" "$remote_port" "$local_port" > "$AGENT_PLIST"
  plutil -lint "$AGENT_PLIST" >/dev/null
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$AGENT_PLIST"
  launchctl kickstart -k "$domain/$LABEL" >/dev/null 2>&1 || true
  echo "Installed $LABEL: 127.0.0.1:$local_port → $host:127.0.0.1:$remote_port, always on."
  echo "Log: $AGENT_LOG · check: $0 status · remove: $0 uninstall"
}

agent_status() {
  domain="gui/$(id -u)"
  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    launchctl print "$domain/$LABEL" | awk '/^\tstate =|^\tpid =|last exit code/ { sub(/^\t+/, ""); print }'
  else
    echo "$LABEL is not installed."
  fi
  port="$(sed -n 's:.*<string>\([0-9][0-9]*\)</string>.*:\1:p' "$AGENT_PLIST" 2>/dev/null | tail -1)"
  port="${port:-8188}"
  if curl -fsS -m 3 "http://127.0.0.1:$port/system_stats" >/dev/null 2>&1; then
    echo "ComfyUI answers on http://127.0.0.1:$port"
  else
    echo "Nothing answers on http://127.0.0.1:$port"
  fi
  [ -f "$AGENT_LOG" ] && { echo "--- last log lines"; tail -5 "$AGENT_LOG"; }
  return 0
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENT_PLIST" "$AGENT_BIN"
  echo "Removed $LABEL (the log stays at $AGENT_LOG)."
}

case "${1:-}" in
  install) shift; install_agent "$@"; exit 0 ;;
  status) agent_status; exit 0 ;;
  uninstall) uninstall_agent; exit 0 ;;
  ''|-h|--help) usage; [ -z "${1:-}" ] && exit 64 || exit 0 ;;
esac

once=0
batch=0
while :; do
  case "${1:-}" in
    --once) once=1; shift ;;
    --batch) batch=1; shift ;;
    *) break ;;
  esac
done
host="${1:-}"
remote_port="${2:-8188}"
local_port="${3:-8188}"
[ -n "$host" ] || { usage; exit 64; }
check_port "$remote_port"; check_port "$local_port"

if lsof -nP -iTCP:"$local_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "127.0.0.1:$local_port is already taken on this machine:" >&2
  lsof -nP -iTCP:"$local_port" -sTCP:LISTEN >&2 || true
  echo "Stop the local ComfyUI (or pick another LOCAL_PORT and set it in LU → Settings → ComfyUI)." >&2
  # Under launchd, wait before exiting so a busy port does not spin the agent.
  [ "$batch" -eq 1 ] && sleep 60
  exit 69
fi

probe() {
  # ComfyUI answers /system_stats once the forward is up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 3 "http://127.0.0.1:$local_port/system_stats" >/dev/null 2>&1; then
      version="$(curl -fsS -m 3 "http://127.0.0.1:$local_port/system_stats" \
        | sed -n 's/.*"comfyui_version": *"\([^"]*\)".*/\1/p')"
      echo "$(date '+%F %T') ComfyUI ${version:-?} on $host is reachable at http://127.0.0.1:$local_port — LU can use it now."
      return 0
    fi
    sleep 1
  done
  echo "$(date '+%F %T') Tunnel is up, but nothing answers on $host:127.0.0.1:$remote_port. Is ComfyUI running there?" >&2
  return 1
}

delay=2
while :; do
  echo "$(date '+%F %T') Tunnel 127.0.0.1:$local_port → $host:127.0.0.1:$remote_port"
  if [ "$batch" -eq 1 ]; then
    set -- -o BatchMode=yes -o ConnectTimeout=10
  else
    set --
  fi
  ssh -N "$@" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -L "127.0.0.1:$local_port:127.0.0.1:$remote_port" \
    "$host" &
  ssh_pid=$!
  trap 'kill "$ssh_pid" 2>/dev/null; exit 0' INT TERM
  probe || true
  status=0
  wait "$ssh_pid" || status=$?
  [ "$once" -eq 1 ] && exit "$status"
  echo "$(date '+%F %T') Tunnel closed (ssh exit $status); reconnecting in ${delay}s…" >&2
  sleep "$delay"
  [ "$delay" -lt 30 ] && delay=$((delay * 2))
done
