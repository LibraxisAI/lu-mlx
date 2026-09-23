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
#   scripts/comfy-tunnel.sh SSH_HOST [REMOTE_PORT] [LOCAL_PORT]
#   scripts/comfy-tunnel.sh --once SSH_HOST     # no reconnect loop
#
# SSH_HOST is anything `ssh` accepts (an alias from ~/.ssh/config, user@host).
# Ports default to 8188 on both ends. Ctrl-C closes the tunnel.
set -eu

once=0
if [ "${1:-}" = "--once" ]; then
  once=1
  shift
fi
host="${1:-}"
remote_port="${2:-8188}"
local_port="${3:-8188}"

if [ -z "$host" ] || [ "$host" = "-h" ] || [ "$host" = "--help" ]; then
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  [ -z "$host" ] && exit 64 || exit 0
fi
for port in "$remote_port" "$local_port"; do
  case "$port" in
    ''|*[!0-9]*) echo "Port must be a number, got '$port'" >&2; exit 64 ;;
  esac
done

if lsof -nP -iTCP:"$local_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "127.0.0.1:$local_port is already taken on this machine:" >&2
  lsof -nP -iTCP:"$local_port" -sTCP:LISTEN >&2 || true
  echo "Stop the local ComfyUI (or pick another LOCAL_PORT and set it in LU → Settings → ComfyUI)." >&2
  exit 69
fi

probe() {
  # ComfyUI answers /system_stats once the forward is up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -m 3 "http://127.0.0.1:$local_port/system_stats" >/dev/null 2>&1; then
      version="$(curl -fsS -m 3 "http://127.0.0.1:$local_port/system_stats" \
        | sed -n 's/.*"comfyui_version": *"\([^"]*\)".*/\1/p')"
      echo "ComfyUI ${version:-?} on $host is reachable at http://127.0.0.1:$local_port — LU can use it now."
      return 0
    fi
    sleep 1
  done
  echo "Tunnel is up, but nothing answers on $host:127.0.0.1:$remote_port. Is ComfyUI running there?" >&2
  return 1
}

delay=2
while :; do
  echo "Tunnel 127.0.0.1:$local_port → $host:127.0.0.1:$remote_port (Ctrl-C to stop)"
  ssh -N \
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
  echo "Tunnel closed (ssh exit $status); reconnecting in ${delay}s…" >&2
  sleep "$delay"
  [ "$delay" -lt 30 ] && delay=$((delay * 2))
done
