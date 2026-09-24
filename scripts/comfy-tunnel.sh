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
#   comfy-tunnel.sh SSH_HOST [PORT...]          # foreground, reconnects
#   comfy-tunnel.sh --once SSH_HOST [PORT...]   # foreground, no reconnect
#   comfy-tunnel.sh install SSH_HOST [PORT...]  # macOS: always-on LaunchAgent
#   comfy-tunnel.sh install --dry-run SSH_HOST [PORT...]  # print the LaunchAgent only
#   comfy-tunnel.sh status                      # agent state, ports, last log lines
#   comfy-tunnel.sh uninstall                   # stop and remove the agent
#
# SSH_HOST is anything `ssh` accepts (an alias from ~/.ssh/config, user@host).
# PORT is N (same port both ends) or REMOTE:LOCAL; default 8188 (ComfyUI).
# One SSH session carries every port, e.g. `install host-a 8188 8000` also
# brings the chat model on 8000. The LaunchAgent starts at login and
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

# PORT or REMOTE:LOCAL → "REMOTE LOCAL"
split_spec() {
  case "$1" in
    *:*) remote="${1%%:*}"; local_="${1#*:}" ;;
    *) remote="$1"; local_="$1" ;;
  esac
  check_port "$remote"; check_port "$local_"
  printf '%s %s\n' "$remote" "$local_"
}

http_code() {
  curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null || true
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

agent_plist() {
  host="$1"; shift
  specs=""
  for spec in "$@"; do specs="$specs    <string>$spec</string>
"; done
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
${specs}  </array>
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
  [ -n "$host" ] || { echo "install needs SSH_HOST" >&2; exit 64; }
  shift
  [ "$#" -gt 0 ] || set -- 8188
  for spec in "$@"; do split_spec "$spec" >/dev/null; done
  if [ "$dry_run" -eq 1 ]; then
    agent_plist "$host" "$@"
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
  agent_plist "$host" "$@" > "$AGENT_PLIST"
  plutil -lint "$AGENT_PLIST" >/dev/null
  domain="gui/$(id -u)"
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$AGENT_PLIST"
  launchctl kickstart -k "$domain/$LABEL" >/dev/null 2>&1 || true
  echo "Installed $LABEL: $host ports $*, always on."
  echo "Log: $AGENT_LOG · check: $0 status · remove: $0 uninstall"
}

agent_status() {
  domain="gui/$(id -u)"
  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    launchctl print "$domain/$LABEL" | awk '/^\tstate =|^\tpid =|last exit code/ { sub(/^\t+/, ""); print }'
  else
    echo "$LABEL is not installed."
  fi
  specs="$(sed -n 's:.*<string>\([0-9][0-9:]*\)</string>.*:\1:p' "$AGENT_PLIST" 2>/dev/null || true)"
  for spec in ${specs:-8188}; do
    # split_spec prints "REMOTE LOCAL" (digits only): split on purpose.
    # shellcheck disable=SC2046
    set -- $(split_spec "$spec")
    code="$(http_code "$2")"
    if [ "$code" != "000" ]; then
      echo "127.0.0.1:$2 answers HTTP $code (→ remote $1)"
    else
      echo "127.0.0.1:$2 does not answer (→ remote $1)"
    fi
  done
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
[ -n "$host" ] || { usage; exit 64; }
shift
[ "$#" -gt 0 ] || set -- 8188
forwards=""
locals=""
for spec in "$@"; do
  # split_spec prints "REMOTE LOCAL" (digits only): split on purpose.
  # shellcheck disable=SC2046
  set -- $(split_spec "$spec")
  if lsof -nP -iTCP:"$2" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "127.0.0.1:$2 is already taken on this machine:" >&2
    lsof -nP -iTCP:"$2" -sTCP:LISTEN >&2 || true
    echo "Stop what listens there (or map it: REMOTE:OTHER_LOCAL)." >&2
    # Under launchd, wait before exiting so a busy port does not spin the agent.
    [ "$batch" -eq 1 ] && sleep 60
    exit 69
  fi
  forwards="$forwards -L 127.0.0.1:$2:127.0.0.1:$1"
  locals="$locals $2"
done

probe() {
  # A forwarded port always accepts locally (ssh listens); only an HTTP answer
  # (any status, even 401) proves the service on the other end is alive.
  for port in $locals; do
    code=000
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      code="$(http_code "$port")"
      [ "$code" != "000" ] && break
      sleep 1
    done
    if [ "$code" = "000" ]; then
      echo "$(date '+%F %T') 127.0.0.1:$port: tunnel up, but nothing answers on $host. Is the service running there?" >&2
      continue
    fi
    version="$(curl -fsS -m 3 "http://127.0.0.1:$port/system_stats" 2>/dev/null \
      | sed -n 's/.*"comfyui_version": *"\([^"]*\)".*/\1/p')"
    if [ -n "$version" ]; then
      echo "$(date '+%F %T') ComfyUI $version on $host is reachable at http://127.0.0.1:$port — LU can use it now."
    else
      echo "$(date '+%F %T') 127.0.0.1:$port → $host answers (HTTP $code)."
    fi
  done
}

delay=2
while :; do
  echo "$(date '+%F %T') Tunnel to $host:$forwards"
  if [ "$batch" -eq 1 ]; then
    set -- -o BatchMode=yes -o ConnectTimeout=10
  else
    set --
  fi
  # $forwards is our own "-L 127.0.0.1:L:127.0.0.1:R" list (digits only): split on purpose.
  # Compression: ComfyUI's /object_info is ~2.8 MB of JSON and LU's Rust proxy
  # has no gzip. Over a 250 ms tailnet path (2026-09-24, laptop -> host-a) it
  # took 10-12 s, blew the proxy's per-call timeout mid-body ("error decoding
  # response body"), and the direct-fetch fallback then hit ComfyUI's 403 for
  # Origin tauri://localhost. With zlib on the tunnel the same call took 0.5 s.
  # shellcheck disable=SC2086
  ssh -N "$@" \
    -o Compression=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    $forwards \
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
