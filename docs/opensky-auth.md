# OpenSky Auth Setup

God's Eye View uses one of two auth modes for `/api/opensky`:

- `OPENSKY_AUTH_MODE=oauth` (default): OAuth2 client credentials, or anonymous
  access while no client is configured
- `OPENSKY_AUTH_MODE=anon`: anonymous access, rate-limited

OpenSky's REST API accepts only the OAuth2 client credentials flow; Basic
authentication with a username and password is no longer accepted. The old
`basic` and `auto` modes therefore mean `oauth`, with a warning at startup.

## Quick Start (OAuth Client JSON)

Import credentials from JSON (`clientId`/`clientSecret` or `client_id`/`client_secret`) into Keychain:

```bash
./scripts/opensky-import-client.sh ~/Downloads/credentials.json
# or: pnpm run opensky:import ~/Downloads/credentials.json
```

Then launch:

```bash
./scripts/dev-fresh.sh
```

Expected startup lines:

- `OpenSky auth mode: oauth`
- `OpenSky OAuth: configured`

## Optional: Launch With File (No Keychain Import)

```bash
OPENSKY_CREDENTIALS_FILE=~/Downloads/credentials.json ./scripts/dev-fresh.sh
```

Launchers resolve OAuth creds in this order:

1. `OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`
2. `OPENSKY_CREDENTIALS_FILE`
3. Keychain (`opensky-network` / `client_id`, `client_secret`)

## Troubleshooting

`pnpm run doctor` checks the auth mode, that both halves of the client are
set, and the credentials file, without starting the server.

Inspect proxy headers:

```bash
curl -si http://localhost:4173/api/opensky | grep -iE 'HTTP/|X-OpenSky-Auth'
```

Useful reasons:

- `oauth_invalid_or_missing`: OAuth client not found/usable
- `oauth_invalid_credentials`: OAuth client rejected by OpenSky
- `rate_limited`: OpenSky throttling
