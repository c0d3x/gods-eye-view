#!/usr/bin/env bash
# dev-fresh.sh pinned to the loopback address: whatever HOST says, the dev
# server listens on 127.0.0.1 only, so nothing on the network can reach the
# keys it brokers. Everything else, keys from .env and the Keychain
# included, works as in dev-fresh.sh.
set -euo pipefail
HOST=127.0.0.1 exec bash "$(dirname "${BASH_SOURCE[0]}")/dev-fresh.sh" "$@"
