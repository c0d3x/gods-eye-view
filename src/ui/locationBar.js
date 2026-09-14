// src/ui/locationBar.js — the Location bar: the preset cities and their
// points of interest, free-text search, the transitions that fly the camera
// between them, and the collapsed readout of where it went.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state. _initLocationBar() wires the
// bar, and _disposeLocationBar() removes its keyboard listener.
import { CITY_POIS, flyToPresetLocation, flyToPOI, searchAndFlyTo } from '../locations.js';
import { locationMiniStatus } from '../locationStatus.js';
import {
  suspendDetection,
  resumeDetection,
} from '../data/detection.js';
import trafficLayer from '../data/traffic.js';

export class LocationBar {
  /** Settle only the search generation that still owns the shared input UI. */
  _settleLocationSearchUi(generation) {
    if (this._activeLocationSearchGeneration !== generation) return;
    this._activeLocationSearchGeneration = null;
    this._locationSearch?.classList.remove('searching', 'expanded');
    if (this._locationSearch) this._locationSearch.value = '';
    this._locationSearch?.blur();
  }

  // ── Location Bar ─────────────────────────────

  /**
   * Initializes the location bar: renders city pills from CITY_POIS, sets up
   * QWERTY keyboard navigation for POI selection, wires the search toggle
   * and geocoding search input.
   * @returns {void}
   */
  _initLocationBar() {
    const QWERTY_KEYS = ['Q', 'W', 'E', 'R', 'T'];

    // Render city pills (no submenu wrappers — POI row is separate)
    for (const [cityId, city] of Object.entries(CITY_POIS)) {
      const pill = document.createElement('button');
      pill.className = 'location-pill';
      pill.dataset.locationId = cityId;
      pill.textContent = city.name;
      pill.addEventListener('click', () => this._onCityPillClick(cityId));
      this._locationPills.appendChild(pill);
    }

    // QWERTY keyboard navigation for POIs
    this._poiKeydownHandler = (e) => {
      if (!this._expandedCityId) return;
      // Bail while a form control is focused so POI hotkeys don't fire from a
      // <select> dropdown's type-ahead or while typing in a field (M9).
      const isFormControl = e.target?.matches?.('select, input, textarea')
        || e.target === this._locationSearch;
      if (isFormControl) return;

      const keyIndex = QWERTY_KEYS.indexOf(e.key.toUpperCase());
      if (keyIndex === -1) return;

      const city = CITY_POIS[this._expandedCityId];
      if (city && keyIndex < city.pois.length) {
        this._onPoiClick(this._expandedCityId, keyIndex);
      }
    };
    document.addEventListener('keydown', this._poiKeydownHandler);

    // Search toggle (expand/collapse)
    this._searchToggle.addEventListener('click', () => {
      this._locationSearch.classList.toggle('expanded');
      if (this._locationSearch.classList.contains('expanded')) {
        this._locationSearch.focus();
      }
    });

    // Search submit on Enter
    this._locationSearch.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const query = this._locationSearch.value.trim();
        if (!query) return;
        const generation = this._beginDeferredNavigation('location');
        if (generation === false) {
          this._locationSearch.classList.remove('searching');
          this._locationSearch.blur();
          return;
        }
        this._activeLocationSearchGeneration = generation;
        this._locationSearch.classList.add('searching');
        try {
          const destination = await searchAndFlyTo(this.viewer, query, {
            beforeFly: () => this._reassertNavigationHandoff(generation),
          });
          if (this._disposed || generation !== this._navigationGeneration) return;
          if (destination?.cancelled) {
            // Authority changed while the lookup was resolving; remain inert.
          } else if (destination) {
            // The ACTIVE STYLE indicator reports the STYLE and nothing else.
            // Writing the searched city here made the top-right corner read
            // "ACTIVE STYLE / TOKYO"; where the camera is belongs to the
            // LOCATION panel's own readout, which is updated below.
            //
            // Set before _setActiveLocation(null) so its own mini-status
            // refresh already sees the destination — the readout never blinks
            // through "Location: --" on the way to the searched place.
            this._searchedLocationLabel = destination.label || query;
            this._setActiveLocation(null);
            this._currentPoi = null;
            this._collapsePOIRow();
            this._updateLocationMiniStatus();
          } else {
            this._showToast('Location not found');
          }
        } catch (err) {
          console.error('[Search] Geocoding failed:', err);
          if (this._disposed || generation !== this._navigationGeneration) return;
          this._showToast('Search failed');
        } finally {
          this._settleLocationSearchUi(generation);
        }
      }
    });
  }

  /**
   * Signals the start of an inter-city world jump: notifies the traffic layer
   * to pause tile fetching and suspends detection overlays to prevent stale
   * rendering during the flight.
   * @returns {void}
   */
  _beginWorldJumpTransition() {
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  /**
   * Signals the end of an inter-city world jump: resumes traffic tile fetching,
   * resumes detection overlays, and forces a traffic sync chip update.
   * @returns {void}
   */
  _endWorldJumpTransition() {
    clearTimeout(this._trafficTransitionTimer);
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  /**
   * Wraps a fly-to action with world-jump transition hooks when the target
   * city differs from the current one. Applies begin/end transition signals
   * with a 5.2s safety timeout to guarantee cleanup if the flight callback
   * never fires onComplete.
   * @param {boolean} cityChanged - Whether the destination is in a different city.
   * @param {function} flyAction - Callback receiving `{onStart, onComplete}` hooks; should return a result with targetPosition.
   * @returns {*} Return value from flyAction.
   */
  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed) return;
        completed = true;
        this._endWorldJumpTransition();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  /**
   * Release camera ownership when a resolved Location destination starts.
   * Contact mode and its selected subject remain intact so FOCUS can return to
   * that subject after the user finishes inspecting the destination.
   * @returns {boolean} Whether a Contact subject remains selected.
   */
  beginLocationNavigation() {
    this._stampNavigation();
    this.cockpitView?.exit({ restoreTracking: false });
    return this._releaseFollowCamera({ preserveVesselSelection: false });
  }

  /**
   * Handles a city pill click: toggles POI row collapse if same city,
   * otherwise expands the POI row, flies to the city's first POI, and
   * tracks the target position for orbit mode.
   * @param {string} cityId - Identifier of the clicked city.
   * @returns {void}
   */
  _onCityPillClick(cityId) {
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged = this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) => flyToPresetLocation(this.viewer, cityId, hooks));
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Handles a POI pill click: stops orbit, flies to the POI, highlights it,
   * and saves the target position for future orbit activation.
   * @param {string} cityId - Parent city identifier.
   * @param {number} poiIndex - Index of the POI within the city's pois array.
   * @returns {void}
   */
  _onPoiClick(cityId, poiIndex) {
    const isCityChanged = this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) => flyToPOI(this.viewer, cityId, poiIndex, hooks));
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
  }

  /**
   * Builds and shows the POI pill row for a city. Each pill displays a
   * QWERTY keyboard shortcut key and the POI name.
   * @param {string} cityId - City whose POIs to render.
   * @returns {void}
   */
  _expandPOIRow(cityId) {
    const QWERTY_KEYS = ['Q', 'W', 'E', 'R', 'T'];
    const city = CITY_POIS[cityId];
    if (!city) return;

    this._expandedCityId = cityId;

    // Build POI pill buttons
    this._poiRow.innerHTML = '';
    city.pois.forEach((poi, idx) => {
      const pill = document.createElement('button');
      pill.className = 'poi-pill';
      pill.dataset.poiIndex = idx;
      const keySpan = document.createElement('span');
      keySpan.className = 'poi-pill-key';
      keySpan.textContent = QWERTY_KEYS[idx] || String(idx + 1);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'poi-pill-name';
      nameSpan.textContent = poi.name;
      pill.append(keySpan, nameSpan);
      pill.addEventListener('click', () => this._onPoiClick(cityId, idx));
      this._poiRow.appendChild(pill);
    });

    // Animate expansion
    requestAnimationFrame(() => {
      this._poiRow.classList.add('expanded');
      this._locationBarDivider.classList.add('visible');
    });
  }

  /**
   * Hides the POI pill row and clears the expanded city state.
   * @returns {void}
   */
  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._poiRow.classList.remove('expanded');
    this._locationBarDivider.classList.remove('visible');
  }

  /**
   * Highlights the active POI pill and removes highlight from all others.
   * @returns {void}
   */
  _updatePoiHighlight() {
    this._poiRow.querySelectorAll('.poi-pill').forEach(pill => {
      pill.classList.toggle('active', parseInt(pill.dataset.poiIndex) === this._activePoiIndex);
    });
  }

  /**
   * Forget the last free-text search destination and repaint the LOCATION
   * readout. Public so camera owners that fly on their own — scene playback
   * most of all — can invalidate it without reaching into private state.
   * @returns {void}
   */
  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  /**
   * Sets the active city location, highlights its pill, and updates the mini-status readout.
   * @param {string|null} locationId - City identifier, or null to clear.
   * @returns {void}
   */
  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationPills.querySelectorAll('.location-pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.locationId === locationId);
    });
    this._updateLocationMiniStatus();
  }

  /**
   * Updates the collapsed mini-status readout with the current destination:
   * a preset city + POI/landmark, or the last free-text geocode search.
   * @returns {void}
   */
  _updateLocationMiniStatus() {
    if (!this._locationMiniCity || !this._locationMiniPoi) return;
    const lines = locationMiniStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
    this._locationMiniCity.textContent = lines.city;
    this._locationMiniPoi.textContent = lines.poi;
  }

  /**
   * Remove the bar's keyboard listener when StyleManager is disposed.
   */
  _disposeLocationBar() {
    if (this._poiKeydownHandler) {
      document.removeEventListener('keydown', this._poiKeydownHandler);
      this._poiKeydownHandler = null;
    }
  }
}
