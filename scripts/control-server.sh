#!/usr/bin/env bash
# scripts/control-server.sh -- run the Quake 2 control API (control/server.mjs)
# in the foreground, for a quick try: Ctrl-C stops it again.
#
# Same process the user unit runs (deploy/quake2-control.service): bound to
# 127.0.0.1:4233, never mounted on the box-proxied app server. The server itself
# prints the port and a one-line how-to on start.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot enter $ROOT" >&2; exit 1; }

exec node control/server.mjs
