# God's Eye View Current State

The runtime reference for God's Eye View, one page per subsystem. It
describes how the app behaves now; `CHANGELOG.md` records how it got here.

## Pages

- [Application, operations and tooling](current-state/operations-and-tooling.md): startup and shutdown, the render governor, operational notes, formatting and package checks, and the dependency baseline.
- [Keys, launchers and the dev server](current-state/keys-and-server.md): Google keys, authentication and launch, proxy failure responses, and proxy caches.
- [Data layers](current-state/layers.md): the active layers, infrastructure markers, FIRMS, installations, earthquakes and launches, and Space Missions.
- [Vessels and cameras](current-state/vessels-and-cameras.md): live AIS and its health, vessel ownership and camera transfer, and CCTV focus.
- [Aircraft tracking, trails and heights](current-state/tracking-and-heights.md): motion and symbology, 3D aircraft, detection, trails, ground floors and tracked contacts.
- [Contacts, context and the cockpit](current-state/contacts-and-cockpit.md): the Contacts coordinator, the Context, Cockpit and Radio contract, and cockpit behavior.
- [World overlay: labels and cards](current-state/world-overlay.md): the overlay host and its migrations, label conventions, and card ownership.
- [Interface, keyboard and accessibility](current-state/ui.md): UI defaults, keyboard and focus, map stacks, status chips, panels and loading.
- [First run and share links](current-state/first-run-and-sharing.md): the first-run mission launcher and share-link state.
- [Voice, HUD summary and scenes](current-state/voice-and-scenes.md): voice control, the AI HUD summary, map annotations and scene playback.

## Runtime Stack

- Vite + CesiumJS app with Google Photorealistic 3D Tiles
- Scene/HUD/style systems in `src/ui.js` and `src/hud.js`
- Layer management in `src/data/manager.js`
- Map stack switching in `src/mapStackController.js`
- Voice control in `src/voice/` (OpenAI Realtime over WebRTC)
- Voice map whiteboard annotations in `src/annotations/`
- 3D aircraft/model tracking surfaces in `src/data/aircraftLayerCore.js`, which `src/data/flights.js`
  and `src/data/militaryFlights.js` configure for their feeds
- Detection overlay and tracked-target readout in `src/data/detection.js`, `src/data/detectionDraw.js`, and `src/data/trackedReadout.js`
- API wiring in `vite.config.js`; the routes live under `server/` (`proxies/`, `ais/`, `realtime/`)
  and the helpers they share in `server/lib/`

## Canonical Docs Order

Use docs in this order when details conflict:

1. `docs/CURRENT-STATE.md` and the pages it lists (this reference)
2. `docs/opensky-auth.md` (OpenSky authentication)
3. `CHANGELOG.md` (release history)

Historical planning documents may not match runtime behavior.

## Current Baseline

- Repository metadata and public URLs use the `c0d3x/gods-eye-view` project
  identity, a fork of `bilawalsidhu/gods-eye-view`. Runtime behavior is defined
  by this document and the current source tree rather than historical branch
  notes.

## Maintenance Rule

When runtime behavior or architecture changes, update the page that
describes it in the same change set as the code. Record dated change notes
in `CHANGELOG.md`, not here.
