#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v security >/dev/null 2>&1; then
  echo "error: macOS 'security' command not found"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to parse JSON credentials"
  exit 1
fi

CREDENTIALS_FILE="${1:-${OPENSKY_CREDENTIALS_FILE:-}}"
if [[ -z "${CREDENTIALS_FILE}" ]]; then
  echo "usage: ./scripts/opensky-import-client.sh /path/to/credentials.json"
  echo "or set OPENSKY_CREDENTIALS_FILE and run ./scripts/opensky-import-client.sh"
  exit 1
fi

if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  echo "error: credentials file not found: ${CREDENTIALS_FILE}"
  exit 1
fi

PARSED="$(node -e "const fs=require('fs');const p=process.argv[1];const raw=JSON.parse(fs.readFileSync(p,'utf8'));const id=String(raw.clientId??raw.client_id??'').trim();const secret=String(raw.clientSecret??raw.client_secret??'').trim();if(!id||!secret){process.exit(2)};process.stdout.write(id+'\t'+secret);" "${CREDENTIALS_FILE}" 2>/dev/null || true)"
if [[ "${PARSED}" != *$'\t'* ]]; then
  echo "error: could not parse clientId/clientSecret from ${CREDENTIALS_FILE}"
  exit 1
fi

CLIENT_ID="${PARSED%%$'\t'*}"
CLIENT_SECRET="${PARSED#*$'\t'}"
if [[ -z "${CLIENT_ID}" || -z "${CLIENT_SECRET}" ]]; then
  echo "error: credentials file is missing client id or client secret"
  exit 1
fi

# Hand each value to `security -i` on stdin. printf is a shell builtin, so
# neither value appears in a process's argument list, where `ps` would show
# it; `security add-generic-password -w <value>` would put it there.
# `security -i` has its own quoting rules, so only plain token characters are
# passed this way.
TOKEN_RE='^[A-Za-z0-9._~+/=-]+$'
if [[ ! "${CLIENT_ID}" =~ ${TOKEN_RE} || ! "${CLIENT_SECRET}" =~ ${TOKEN_RE} ]]; then
  echo "error: the client id or secret contains characters this script can't pass to the Keychain safely."
  echo "Store them by hand instead; security prompts for each value:"
  echo "  security add-generic-password -U -s opensky-network -a client_id -w"
  echo "  security add-generic-password -U -s opensky-network -a client_secret -w"
  exit 1
fi
printf 'add-generic-password -U -s opensky-network -a client_id -w %s\n' "${CLIENT_ID}" | security -i >/dev/null
printf 'add-generic-password -U -s opensky-network -a client_secret -w %s\n' "${CLIENT_SECRET}" | security -i >/dev/null

echo "OpenSky OAuth client credentials stored in Keychain:"
echo "  service=opensky-network account=client_id"
echo "  service=opensky-network account=client_secret"
