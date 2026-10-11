# The Mac app

God's Eye View can run as a Mac app for Apple Silicon: one window, no
terminal, no Node or pnpm on the Mac that runs it. It is the same app as
`pnpm run dev`, with every layer, voice, the SDR receiver and the MCP server,
packaged with Electron. This fork builds it for personal use; nothing is
published.

## Build it

On a Mac with this repository set up (`pnpm install --frozen-lockfile`):

```bash
pnpm run app:build
```

That builds the web app without any baked-in keys, packages it with
Electron, signs it and makes a `.dmg`:

- `release/mac-arm64/God's Eye View.app`
- `release/God's Eye View-<version>-arm64.dmg`

The first build downloads Electron (about 130 MB). The `.app` is about
580 MB, the `.dmg` about 210 MB.

To keep the build and the downloads off a small internal disk, point them at
another drive:

```bash
export GEV_APP_OUT_DIR=/Volumes/Backup/dev/gods-eye-view/release
export electron_config_cache=/Volumes/Backup/dev/gods-eye-view/cache/electron
export ELECTRON_BUILDER_CACHE=/Volumes/Backup/dev/gods-eye-view/cache/electron-builder
pnpm run app:build
```

Then check the built app works:

```bash
pnpm run app:smoke
```

It launches the app, checks the page, the runtime config, Provider Settings
and an unknown route, checks that the server listens on 127.0.0.1 only, quits
it, and checks that nothing was written into the signed bundle.

## Signing

`pnpm run app:build` signs with the best certificate in your login Keychain:

1. **Developer ID Application**: the certificate Apple notarizes. A notarized
   app opens on any of your Macs without a warning.
2. **Apple Development**: a stable signature, so the microphone and Keychain
   permissions survive rebuilds. It runs on the Mac that built it; another
   Mac asks once (see below).
3. Otherwise an ad-hoc signature, which runs on the Mac that built it.

Set `GEV_APP_SIGN_IDENTITY` to a certificate name or its SHA-1 hash to choose
one, or to `-` for an ad-hoc signature.

## Notarize it (Developer ID only)

Notarizing needs a **Developer ID Application** certificate. Create it once:

1. In Xcode, open **Settings → Accounts**, select your team and choose
   **Manage Certificates…**.
2. Click **+** and choose **Developer ID Application**. Only the account
   holder of the team can create one.

Then save your notarization credentials in the Keychain, once. Use an
app-specific password from [account.apple.com](https://account.apple.com):

```bash
xcrun notarytool store-credentials gods-eye-view --apple-id <your Apple ID> --team-id <your team ID>
```

After that, every build can be notarized:

```bash
pnpm run app:build
pnpm run app:notarize
```

`app:notarize` submits the `.dmg`, waits for Apple, and staples the ticket to
it. `GEV_NOTARY_PROFILE` names a different keychain profile. The credentials
stay in your Keychain; nothing goes into the repository or CI.

## Install it

On the Mac that built it:

```bash
pnpm run app:install
```

That copies the app to `/Applications`. On your other Macs, open the `.dmg`
and drag the app to Applications.

A notarized `.dmg` opens without a warning. One signed with an Apple
Development certificate was not notarized, so the first launch on another Mac
is blocked once: open **System Settings → Privacy & Security** and choose
**Open Anyway** (macOS 15 removed right-click → Open). A copy made without a
quarantine flag, such as with `rsync` or from a USB drive, opens directly.

To update, pull `main`, build again and install the new app over the old one.

## Using it

- **Keys:** the **POWER UP** chip and **God's Eye View → Provider Settings…**
  (⌘,) open Provider Settings, as in the browser. Keys are saved encrypted
  with a key that the macOS Keychain holds, and saving one restarts the
  app's server and reloads the window. Keys in `.env` files or the launchers'
  Keychain items are not read by the app.
- **Voice:** the first time you use the microphone, macOS asks for
  permission. ChatGPT sign-in for voice runs your installed `codex`; the app
  looks for it in Homebrew's, npm's and Codex's usual folders.
- **The SDR receiver:** connecting it shows a list of USB devices to choose
  from.
- **MCP:** while the app runs, MCP clients can connect to
  `http://127.0.0.1:4173/mcp` (the next free port if 4173 is taken; **Help →
  MCP Server Address** shows it).
- **Links** to other sites open in your default browser.

## Where it keeps things

| What | Where |
|---|---|
| Provider keys (encrypted) | `~/Library/Application Support/God's Eye View/provider-keys.enc` |
| Their encryption key | Keychain item "God's Eye View Safe Storage" |
| Window size and position | `~/Library/Application Support/God's Eye View/window-state.json` |
| Provider caches (`.gev-cache`) | `~/Library/Caches/io.github.c0d3x.gods-eye-view/` |

Nothing is written inside the app bundle. To remove the app completely,
delete it from Applications, delete those folders and the Keychain item.

`pnpm run app:dev` runs the app from the repository with Electron's own
binary, under the name "God's Eye View (dev)", so its settings and Keychain
item stay separate from the installed app's.

## How it works

- `app/main.mjs` is Electron's main process. It moves its working directory
  to the cache folder, loads the keys, starts the server and opens the window.
- `app/server.mjs` starts Vite's preview server on 127.0.0.1 with the same
  plugins as `pnpm run dev` (`server/standalone/vite.config.js`), without its
  dotenv loading, plus Provider Settings on the app's key store
  (`app/keyStore.mjs`) and the runtime config (`app/runtimeConfig.mjs`).
- The browser keys reach the page as `window.__GEV_RUNTIME_CONFIG__`
  (`src/runtimeConfig.js`) instead of being baked into the build, so a key
  saved in the app works without rebuilding.
- `app/policy.mjs` holds the rules for links, permissions and the tool PATH;
  `app/packaging.mjs` the electron-builder configuration and the choice of
  certificate; `scripts/app.mjs` the `app:*` commands.

SECURITY.md describes the app's threat model.
