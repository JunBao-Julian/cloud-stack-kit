#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"
test "$(id -u)" = 0 || { echo 'Run as root.' >&2; exit 1; }
command -v python3 >/dev/null || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y python3; }
exec python3 server.py "$@"
