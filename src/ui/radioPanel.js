// src/ui/radioPanel.js — the Radio panel: its station directory, transport and
// tuner band, the Radio launcher in the Context panel's header, and the
// Cockpit's Display and Radio disclosures, all drawn from the radio layer's
// state.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state. _initRadioPanel() wires the
// panel and _disposeRadioPanel() takes it down.
import radioLayer, {
  buildRadioTunerTicks,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  radioTunerSlot,
} from '../data/radio.js';

export class RadioPanel {
  /** Wire the independent Radio companion controls. */
  _initRadioPanel() {
    if (!this._radioPanel) return;
    this._radioTunerAbort?.abort();
    this._radioTunerAbort = new AbortController();
    const tunerListenerOptions = { signal: this._radioTunerAbort.signal };
    const setRadioDisclosure = (expanded, { returnFocus = false } = {}) => {
      const open = Boolean(expanded);
      this._contextRadioDock?.classList.toggle('disclosure-open', open);
      if (this._contextRadioMini) this._contextRadioMini.hidden = !open;
      this._syncContextRadioLauncherState();
      if (!open && returnFocus)
        this._contextRadioToggleBtn?.focus({ preventScroll: true });
    };
    this._setRadioDisclosure = setRadioDisclosure;
    const setCockpitDisclosure = (
      kind,
      expanded,
      { returnFocus = false } = {},
    ) => {
      const displayOpen = kind === 'display' && Boolean(expanded);
      const radioOpen = kind === 'radio' && Boolean(expanded);
      if (displayOpen || radioOpen) this.cockpitView?.setSignalCollapsed(true);
      if (this._cockpitDisplayPanel)
        this._cockpitDisplayPanel.hidden = !displayOpen;
      if (this._cockpitRadioPanel) this._cockpitRadioPanel.hidden = !radioOpen;
      this._cockpitDisplayToggleBtn
        ?.closest('.cockpit-utility-control')
        ?.classList.toggle('is-expanded', displayOpen);
      this._cockpitRadioToggleBtn
        ?.closest('.cockpit-utility-control')
        ?.classList.toggle('is-expanded', radioOpen);
      this._cockpitDisplayToggleBtn?.setAttribute(
        'aria-expanded',
        String(displayOpen),
      );
      this._cockpitRadioToggleBtn?.setAttribute(
        'aria-expanded',
        String(radioOpen),
      );
      if (displayOpen) this._revealCockpitStyleParameters();
      if (this._cockpitDisplayToggleBtn) {
        const action = displayOpen ? 'Collapse' : 'Expand';
        this._cockpitDisplayToggleBtn.textContent = displayOpen ? '▶' : '◀';
        this._cockpitDisplayToggleBtn.setAttribute(
          'aria-label',
          `${action} Cockpit display options`,
        );
        this._cockpitDisplayToggleBtn.title = `${action} Cockpit display options`;
      }
      if (this._cockpitRadioToggleBtn) {
        const action = radioOpen ? 'Collapse' : 'Expand';
        this._cockpitRadioToggleBtn.textContent = radioOpen ? '▶' : '◀';
        this._cockpitRadioToggleBtn.setAttribute(
          'aria-label',
          `${action} Cockpit Radio controls`,
        );
        this._cockpitRadioToggleBtn.title = `${action} Cockpit Radio controls`;
      }
      if (!expanded && returnFocus) {
        (kind === 'display'
          ? this._cockpitDisplayToggleBtn
          : this._cockpitRadioToggleBtn
        )?.focus({ preventScroll: true });
      }
      if (
        !displayOpen &&
        !radioOpen &&
        this.cockpitView?.active &&
        !this.cockpitView.signalUserCollapsed
      ) {
        this.cockpitView.setSignalCollapsed(false);
      }
      this.cockpitView?.scheduleContextLayout();
    };
    this._setCockpitDisclosure = setCockpitDisclosure;
    const syncTunerTape = (coordinate) => {
      const scale = this._radioTuner?.querySelector('.radio-tuner-scale');
      const dial = this._radioTuner?.querySelector('.radio-tuner-dial');
      if (!scale || !dial) return null;
      const model = buildRadioTunerTicks(
        coordinate,
        this._radioTunerStations.length,
        dial.getBoundingClientRect().width,
      );
      while (scale.children.length < model.ticks.length) {
        const tick = document.createElement('span');
        tick.className = 'radio-tuner-tick';
        scale.append(tick);
      }
      while (scale.children.length > model.ticks.length)
        scale.lastElementChild?.remove();
      model.ticks.forEach((entry, index) => {
        const tick = scale.children[index];
        tick.style.left = `${entry.xPx}px`;
        tick.textContent = entry.label;
        tick.dataset.stationIndex = String(entry.stationIndex);
        tick.classList.toggle('is-current', entry.current);
      });
      scale.style.setProperty('--radio-tuner-tick-pitch', `${model.pitchPx}px`);
      return model;
    };
    const tunerPreview = ({
      coordinate = this._radioTunerCoordinate,
      syncStatic = true,
      rotate = true,
    } = {}) => {
      const slot = radioTunerSlot(
        this._radioTunerSlider?.value,
        this._radioTunerStations.length,
      );
      const station = slot.locked
        ? this._radioTunerStations[slot.stationIndex] || null
        : null;
      const resolvedCoordinate =
        this._radioTunerStations.length <= 1
          ? 0
          : Math.min(
              this._radioTunerStations.length - 1,
              Math.max(0, Number(coordinate) || 0),
            );
      const ratio =
        this._radioTunerStations.length === 1
          ? 0.5
          : resolvedCoordinate /
            Math.max(1, this._radioTunerStations.length - 1);
      this._radioTunerCoordinate = resolvedCoordinate;
      this._radioTuner?.style.setProperty('--radio-tuner-ratio', String(ratio));
      this._radioTuner?.classList.toggle(
        'is-static',
        syncStatic ? false : Boolean(this._radioState?.tuningStatic),
      );
      syncTunerTape(resolvedCoordinate);
      if (this._radioTunerValue) {
        this._radioTunerValue.textContent = station
          ? `CH ${String(slot.stationIndex + 1).padStart(2, '0')} / ${String(this._radioTunerStations.length).padStart(2, '0')}`
          : 'NO STATIONS';
      }
      if (this._radioTunerStation)
        this._radioTunerStation.textContent =
          station?.name || 'NO STATION AVAILABLE';
      if (this._radioTunerSlider) {
        this._radioTunerSlider.setAttribute(
          'aria-valuetext',
          station
            ? `${station.name}, station ${slot.stationIndex + 1} of ${this._radioTunerStations.length}`
            : 'No station available',
        );
      }
      if (syncStatic)
        radioLayer.previewTuningStation(station?.id || null, { rotate });
      return station;
    };
    const setTunerDirectory = (pool) => {
      this._radioTunerPool = [...pool];
      this._radioTunerStations = [...pool];
      this._radioTunerBandSignature = this._radioTunerStations
        .map((station) => station.id)
        .join('|');
      if (this._radioTunerSlider) {
        this._radioTunerSlider.min = '0';
        this._radioTunerSlider.max = String(
          Math.max(0, this._radioTunerStations.length - 1),
        );
        this._radioTunerSlider.step = '1';
      }
    };
    const refreshTunerBand = ({ force = false } = {}) => {
      if (
        this._radioTunerDragging ||
        this._radioTuner?.hidden ||
        this._radioTunerSlider?.disabled
      )
        return false;
      const selectedId = this._radioState?.selected?.id || null;
      const pool = radioLayer.getTunerStations(750);
      const poolSignature = pool.map((station) => station.id).join('|');
      const currentPoolSignature = this._radioTunerPool
        .map((station) => station.id)
        .join('|');
      if (
        !force &&
        poolSignature === currentPoolSignature &&
        selectedId === this._radioTunerSelectedId
      )
        return false;
      setTunerDirectory(pool);
      this._radioTunerSelectedId = selectedId;
      const selectedPoolIndex = pool.findIndex(
        (station) => station.id === selectedId,
      );
      const slot = radioTunerSlot(
        selectedPoolIndex >= 0 ? selectedPoolIndex : 0,
        this._radioTunerStations.length,
      );
      this._radioTunerSlider.value = String(slot.slot);
      this._radioTunerCoordinate =
        slot.stationIndex >= 0 ? slot.stationIndex : 0;
      tunerPreview({
        coordinate: this._radioTunerCoordinate,
        syncStatic: false,
      });
      return true;
    };
    this._refreshRadioTunerBand = refreshTunerBand;
    const beginTuner = () => {
      if (this._radioTunerDragging || this._radioTunerSlider?.disabled)
        return false;
      refreshTunerBand();
      if (!this._radioTunerStations.length || !radioLayer.beginTuning())
        return false;
      // A tuner-owned camera preview must never replace the frozen directory.
      // Only an explicit globe pointer/wheel gesture releases camera pinning.
      this._radioTunerBandPinnedForNavigation = true;
      this._radioTunerDragging = true;
      this._radioTuner?.classList.add('is-dragging');
      const selectedIndex = this._radioTunerStations.findIndex(
        (station) => station.id === this._radioState?.selected?.id,
      );
      const slot = radioTunerSlot(
        selectedIndex >= 0 ? selectedIndex : 0,
        this._radioTunerStations.length,
      );
      this._radioTunerSlider.value = String(slot.slot);
      this._radioTunerCoordinate =
        slot.stationIndex >= 0 ? slot.stationIndex : 0;
      this._radioTunerDragStartSlot = slot.slot;
      this._radioTunerDragSnapshot = {
        stations: [...this._radioTunerStations],
        bandSignature: this._radioTunerBandSignature,
        selectedId: this._radioTunerSelectedId,
        slot: slot.slot,
        coordinate: this._radioTunerCoordinate,
      };
      this._radioTunerLastSlot = slot.slot;
      this._radioTunerDragDirection = 0;
      tunerPreview({ coordinate: this._radioTunerCoordinate });
      return true;
    };
    const finishTuner = (commit) => {
      if (!this._radioTunerDragging) return;
      const dragSnapshot = this._radioTunerDragSnapshot;
      if (!commit && dragSnapshot) {
        this._radioTunerStations = [...dragSnapshot.stations];
        this._radioTunerPool = [...dragSnapshot.stations];
        this._radioTunerBandSignature = dragSnapshot.bandSignature;
        this._radioTunerSelectedId = dragSnapshot.selectedId;
        if (this._radioTunerSlider) {
          const startSlot = radioTunerSlot(
            dragSnapshot.slot,
            this._radioTunerStations.length,
          );
          this._radioTunerSlider.max = String(startSlot.max);
          this._radioTunerSlider.value = String(startSlot.slot);
        }
        this._radioTunerCoordinate = Number.isFinite(dragSnapshot.coordinate)
          ? dragSnapshot.coordinate
          : dragSnapshot.slot;
      } else if (!commit && this._radioTunerSlider) {
        this._radioTunerSlider.value = String(this._radioTunerDragStartSlot);
        this._radioTunerCoordinate = this._radioTunerDragStartSlot;
      }
      let station = tunerPreview({
        coordinate: this._radioTunerCoordinate,
        rotate: commit,
      });
      if (commit && !station && this._radioTunerSlider) {
        const snapped = radioTunerCommitSlot(
          this._radioTunerSlider.value,
          this._radioTunerStations.length,
        );
        this._radioTunerSlider.value = String(snapped.slot);
        this._radioTunerCoordinate = snapped.stationIndex;
        station = tunerPreview({ coordinate: this._radioTunerCoordinate });
      }
      let result = null;
      if (commit && station) {
        // Keep the exact band used by the drag so the selected channel cannot
        // jump to a refreshed catalog slot while its camera flight settles.
        this._radioTunerBandPinnedForNavigation = true;
        result = radioLayer.commitTuningStation(station.id, { origin: 'user' });
      } else if (!commit) {
        radioLayer.cancelTuning();
      } else {
        radioLayer.endTuning();
      }
      // Radio emits selection/tuning state synchronously. Keep both the logical
      // drag and the no-transition class active until that state has settled,
      // then restore the exact selected slot before permitting CSS motion.
      this._radioTunerDragging = false;
      this._radioTunerPointerId = null;
      this._radioTunerKeyboardKey = null;
      if (commit && (!result || result.ok)) refreshTunerBand();
      this._radioTunerDragSnapshot = null;
      // Flush the snapped position while transitions are still disabled so
      // removing the drag class cannot interpolate from the released gap.
      void this._radioTunerNeedle?.offsetLeft;
      this._radioTuner?.classList.remove('is-dragging');
      if (result && !result.ok) {
        this._radioTunerBandPinnedForNavigation = false;
        if (result.reason === 'station-unavailable') {
          if (this._radioTunerValue)
            this._radioTunerValue.textContent = 'OFF AIR';
          if (this._radioTunerStation)
            this._radioTunerStation.textContent = 'STATION UNAVAILABLE';
          this._radioTunerSlider?.setAttribute(
            'aria-valuetext',
            'Station unavailable after directory refresh',
          );
        }
      }
    };
    const cycleRadio = (direction, { rotate = true } = {}) => {
      this._radioTunerBandPinnedForNavigation = true;
      const pool = this._radioTunerPool.length
        ? this._radioTunerPool
        : this._radioTunerStations;
      const cycled = radioLayer.cycleStation(direction, {
        rotate,
        stationIds: pool.map((station) => station.id),
        origin: 'user',
      });
      if (!cycled) {
        this._radioTunerBandPinnedForNavigation = false;
        return;
      }
    };
    const toggleRadio = async (trigger) => {
      if (!this._dataManager?.layers?.has('radio')) return;
      if (trigger.getAttribute('aria-busy') === 'true') return;
      const enabling = !this._dataManager.isEnabled('radio');
      const revealAfterEnable = enabling && trigger === this._radioEnableBtn;
      trigger.setAttribute('aria-disabled', 'true');
      trigger.setAttribute('aria-busy', 'true');
      try {
        const toggled = await this._runUserFacingContextAction(
          (notificationToken) =>
            this._dataManager.setEnabled('radio', enabling, {
              origin: 'user',
              notificationToken,
            }),
          `Radio could not ${enabling ? 'start' : 'stop'} cleanly`,
        );
        if (toggled === false) return;
        if (
          enabling &&
          trigger === this._radioEnableBtn &&
          !document
            .getElementById('global-context-panel')
            ?.classList.contains('collapsed')
        ) {
          this.setPanelCollapsed('radio-panel', false, { explicit: true });
        }
        if (revealAfterEnable)
          await this._revealRadioControlsAfterExplicitEnable(trigger);
      } finally {
        trigger.setAttribute('aria-disabled', 'false');
        trigger.setAttribute('aria-busy', 'false');
        if (revealAfterEnable && trigger.isConnected)
          trigger.focus({ preventScroll: true });
      }
    };
    this._radioEnableBtn?.addEventListener(
      'click',
      () => void toggleRadio(this._radioEnableBtn),
    );
    this._contextRadioMiniEnableBtn?.addEventListener(
      'click',
      () => void toggleRadio(this._contextRadioMiniEnableBtn),
    );
    this._cockpitRadioEnableBtn?.addEventListener(
      'click',
      () => void toggleRadio(this._cockpitRadioEnableBtn),
    );
    this._contextRadioToggleBtn?.addEventListener('click', () => {
      const contextPanel = document.getElementById('global-context-panel');
      if (contextPanel && !contextPanel.classList.contains('collapsed')) {
        setRadioDisclosure(false);
        this.setPanelCollapsed('radio-panel', false, { explicit: true });
        void this._revealRadioPanelInsideContext({
          focusTarget: this._radioPanel?.querySelector(
            '[data-collapse-target="radio-panel"]',
          ),
        });
        return;
      }
      setRadioDisclosure(
        !this._contextRadioDock?.classList.contains('disclosure-open'),
      );
    });
    this._contextRadioMiniCloseBtn?.addEventListener('click', () => {
      setRadioDisclosure(false, { returnFocus: true });
    });
    this._contextRadioDetailsBtn?.addEventListener('click', () => {
      if (!this.cockpitView?.active)
        this.setPanelCollapsed('global-context-panel', false, {
          explicit: true,
        });
      this.setPanelCollapsed('radio-panel', false, { explicit: true });
      setRadioDisclosure(false);
      this._radioEnableBtn?.focus({ preventScroll: true });
    });
    this._cockpitRadioToggleBtn?.addEventListener('click', () => {
      const open =
        this._cockpitRadioToggleBtn.getAttribute('aria-expanded') === 'true';
      setCockpitDisclosure('radio', !open);
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!this._contextRadioDock?.classList.contains('disclosure-open'))
          return;
        if (event.target?.closest?.('#context-radio-dock')) return;
        setRadioDisclosure(false);
      },
      tunerListenerOptions,
    );
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (
          !this._cockpitUtilityControls ||
          event.target?.closest?.('#cockpit-utility-controls')
        )
          return;
        if (event.target?.closest?.('.cockpit-vision-controls')) return;
        if (event.target?.closest?.('#left-panel-stack, #cockpit-context'))
          return;
        setCockpitDisclosure('display', false);
        setCockpitDisclosure('radio', false);
      },
      tunerListenerOptions,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key !== 'Escape' ||
          !this._contextRadioDock?.classList.contains('disclosure-open')
        )
          return;
        event.preventDefault();
        // Immediate: a plain stopPropagation() still lets every LATER listener on
        // this same document run, so closing the disclosure ALSO dismissed the
        // first-run launcher — one key, two actions. Matches the cockpit
        // disclosure handler directly below.
        event.stopImmediatePropagation();
        const escapedFromDisclosure =
          event.target === this._contextRadioToggleBtn ||
          this._contextRadioToggleBtn?.contains?.(event.target);
        setRadioDisclosure(false, { returnFocus: !escapedFromDisclosure });
        if (escapedFromDisclosure) this._contextRadioToggleBtn?.blur?.();
      },
      { capture: true, signal: this._radioTunerAbort.signal },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        const displayOpen =
          this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') ===
          'true';
        const radioOpen =
          this._cockpitRadioToggleBtn?.getAttribute('aria-expanded') === 'true';
        if (!displayOpen && !radioOpen) return;
        const nestedPanel = event.target?.closest?.(
          '.panel-collapsible:not(.collapsed), #param-slider-panel:not(.collapsed)',
        );
        if (nestedPanel) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const kind = displayOpen ? 'display' : 'radio';
        const disclosure = displayOpen
          ? this._cockpitDisplayToggleBtn
          : this._cockpitRadioToggleBtn;
        const escapedFromDisclosure =
          event.target === disclosure || disclosure?.contains?.(event.target);
        setCockpitDisclosure(kind, false, {
          returnFocus: !escapedFromDisclosure,
        });
        if (escapedFromDisclosure) disclosure?.blur?.();
      },
      { capture: true, signal: this._radioTunerAbort.signal },
    );
    window.addEventListener(
      'gev:cockpit-mode-changed',
      (event) => {
        if (event?.detail?.active) return;
        setCockpitDisclosure('display', false);
        setCockpitDisclosure('radio', false);
      },
      tunerListenerOptions,
    );
    window.addEventListener(
      'gev:cockpit-signal-expanded',
      () => {
        setCockpitDisclosure('display', false);
      },
      tunerListenerOptions,
    );
    window.addEventListener(
      'gev:cockpit-context-expanded',
      () => {
        this.setPanelCollapsed('data-panel', true);
      },
      tunerListenerOptions,
    );
    this._radioFilter?.addEventListener('change', () => {
      const presentation = radioLayer.getUIState();
      if (!presentation.presentationActive) {
        this._radioFilter.value = presentation.filter;
        return;
      }
      if (this._radioTunerDragging) finishTuner(false);
      if (
        !this._dataManager?.setLayerParams(
          'radio',
          {
            filter: this._radioFilter.value,
          },
          { origin: 'user' },
        )
      ) {
        this._radioFilter.value = radioLayer.getUIState().filter;
        return;
      }
      this._radioTunerBandPinnedForNavigation = false;
      this._radioTunerPool = [];
      refreshTunerBand({ force: true });
    });
    this._radioPrevBtn?.addEventListener('click', () => cycleRadio(-1));
    this._radioNextBtn?.addEventListener('click', () => cycleRadio(1));
    this._radioPlayBtn?.addEventListener(
      'click',
      () => void radioLayer.togglePlayback({ origin: 'user' }),
    );
    this._radioStopBtn?.addEventListener('click', () =>
      radioLayer.stopPlayback({ origin: 'user' }),
    );
    this._radioVolume?.addEventListener('input', () => {
      const value = Number(this._radioVolume.value);
      if (this._radioVolumeValue)
        this._radioVolumeValue.textContent = `${value}%`;
      this._dataManager?.setLayerParams(
        'radio',
        { volume: value / 100 },
        { origin: 'user' },
      );
    });
    this._contextRadioMiniPrevBtn?.addEventListener('click', () =>
      cycleRadio(-1),
    );
    this._contextRadioMiniNextBtn?.addEventListener('click', () =>
      cycleRadio(1),
    );
    this._contextRadioMiniPlayBtn?.addEventListener(
      'click',
      () => void radioLayer.togglePlayback({ origin: 'user' }),
    );
    // Cockpit owns the Cesium camera even though it intentionally clears
    // viewer.trackedEntity. Station changes must never start the map-view
    // rotation/fallback flights that would compete with its preUpdate pose.
    this._cockpitRadioPrevBtn?.addEventListener('click', () =>
      cycleRadio(-1, { rotate: false }),
    );
    this._cockpitRadioNextBtn?.addEventListener('click', () =>
      cycleRadio(1, { rotate: false }),
    );
    this._cockpitRadioPlayBtn?.addEventListener(
      'click',
      () => void radioLayer.togglePlayback({ origin: 'user' }),
    );
    this._contextRadioMiniVolume?.addEventListener('input', () => {
      const value = Number(this._contextRadioMiniVolume.value);
      if (this._contextRadioMiniVolumeValue)
        this._contextRadioMiniVolumeValue.textContent = `${value}%`;
      this._dataManager?.setLayerParams(
        'radio',
        { volume: value / 100 },
        { origin: 'user' },
      );
    });
    this._cockpitRadioVolume?.addEventListener('input', () => {
      const value = Number(this._cockpitRadioVolume.value);
      if (this._cockpitRadioVolumeValue)
        this._cockpitRadioVolumeValue.textContent = `${value}%`;
      this._dataManager?.setLayerParams(
        'radio',
        { volume: value / 100 },
        { origin: 'user' },
      );
    });
    const updateTunerFromPointer = (event) => {
      const rect = this._radioTunerSlider?.getBoundingClientRect();
      if (!rect || !this._radioTunerStations.length) return false;
      const position = radioTunerPointerPosition(
        event.clientX,
        rect.left,
        rect.width,
        this._radioTunerStations.length,
      );
      if (position.stationIndex > this._radioTunerLastSlot)
        this._radioTunerDragDirection = 1;
      else if (position.stationIndex < this._radioTunerLastSlot)
        this._radioTunerDragDirection = -1;
      this._radioTunerLastSlot = position.stationIndex;
      this._radioTunerCoordinate = position.coordinate;
      this._radioTunerSlider.value = String(position.stationIndex);
      tunerPreview({ coordinate: position.coordinate });
      return true;
    };
    this._radioTunerSlider?.addEventListener(
      'pointerdown',
      (event) => {
        if (!beginTuner()) return;
        this._radioTunerPointerId = event.pointerId;
        this._radioTunerSlider.focus({ preventScroll: true });
        try {
          this._radioTunerSlider.setPointerCapture(event.pointerId);
        } catch {
          /* capture is best effort */
        }
        updateTunerFromPointer(event);
        event.preventDefault();
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'pointermove',
      (event) => {
        if (
          !this._radioTunerDragging ||
          this._radioTunerPointerId !== event.pointerId
        )
          return;
        updateTunerFromPointer(event);
        event.preventDefault();
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'input',
      () => {
        if (this._radioTunerPointerId !== null || this._radioTunerKeyboardKey)
          return;
        if (!this._radioTunerDragging && !beginTuner()) return;
        const inputSlot = radioTunerSlot(
          this._radioTunerSlider.value,
          this._radioTunerStations.length,
        );
        if (inputSlot.slot > this._radioTunerLastSlot)
          this._radioTunerDragDirection = 1;
        else if (inputSlot.slot < this._radioTunerLastSlot)
          this._radioTunerDragDirection = -1;
        this._radioTunerLastSlot = inputSlot.slot;
        this._radioTunerCoordinate = inputSlot.stationIndex;
        tunerPreview({ coordinate: this._radioTunerCoordinate });
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'change',
      () => {
        if (this._radioTunerPointerId === null && !this._radioTunerKeyboardKey)
          finishTuner(true);
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'pointerup',
      (event) => {
        if (this._radioTunerPointerId !== event.pointerId) return;
        updateTunerFromPointer(event);
        finishTuner(true);
        try {
          this._radioTunerSlider.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        event.preventDefault();
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'pointercancel',
      (event) => {
        if (
          this._radioTunerPointerId !== null &&
          this._radioTunerPointerId !== event.pointerId
        )
          return;
        try {
          this._radioTunerSlider.releasePointerCapture(event.pointerId);
        } catch {
          /* already released */
        }
        finishTuner(false);
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'lostpointercapture',
      (event) => {
        if (
          this._radioTunerDragging &&
          this._radioTunerPointerId === event.pointerId
        )
          finishTuner(false);
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this._radioTunerDragging) {
          event.preventDefault();
          finishTuner(false);
          return;
        }
        if (
          ![
            'ArrowLeft',
            'ArrowRight',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key)
        )
          return;
        if (!this._radioTunerDragging && !beginTuner()) return;
        event.preventDefault();
        this._radioTunerKeyboardKey = event.key;
        const max = Math.max(0, this._radioTunerStations.length - 1);
        const current = radioTunerSlot(
          this._radioTunerSlider.value,
          this._radioTunerStations.length,
        ).slot;
        const page = Math.max(1, Math.round(max / 10));
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? max
              : event.key === 'PageUp'
                ? current + page
                : event.key === 'PageDown'
                  ? current - page
                  : current + (event.key === 'ArrowRight' ? 1 : -1);
        const slot = radioTunerSlot(next, this._radioTunerStations.length);
        if (slot.slot > this._radioTunerLastSlot)
          this._radioTunerDragDirection = 1;
        else if (slot.slot < this._radioTunerLastSlot)
          this._radioTunerDragDirection = -1;
        this._radioTunerLastSlot = slot.slot;
        this._radioTunerCoordinate = slot.stationIndex;
        this._radioTunerSlider.value = String(slot.slot);
        tunerPreview({ coordinate: this._radioTunerCoordinate });
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'keyup',
      (event) => {
        if (
          !this._radioTunerKeyboardKey ||
          event.key !== this._radioTunerKeyboardKey
        )
          return;
        event.preventDefault();
        finishTuner(true);
      },
      tunerListenerOptions,
    );
    this._radioTunerSlider?.addEventListener(
      'blur',
      () => finishTuner(true),
      tunerListenerOptions,
    );
    const releaseNavigationBand = () => {
      this._radioTunerBandPinnedForNavigation = false;
    };
    this.viewer?.canvas?.addEventListener(
      'pointerdown',
      releaseNavigationBand,
      tunerListenerOptions,
    );
    this.viewer?.canvas?.addEventListener(
      'wheel',
      releaseNavigationBand,
      tunerListenerOptions,
    );
    // The directory order is catalog/filter authority, not camera authority.
    // Globe motion therefore never rebuilds or re-ranks the frequency band.
    this._radioTunerCameraRemove?.();
    this._radioTunerCameraRemove = null;
    this._radioSelectedHandler = () =>
      this.setPanelCollapsed('radio-panel', false);
    document.addEventListener('gev:radio-selected', this._radioSelectedHandler);
  }

  /**
   * Reveal the newly enabled directory and transport inside Context without
   * moving focus, the page, or the globe. Only the expanded Enable path calls
   * this helper.
   * @param {HTMLElement} trigger Initiating Radio Enable button.
   * @returns {Promise<boolean>} Whether the internal scroller moved.
   */
  async _revealRadioControlsAfterExplicitEnable(trigger) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    const directory = this._radioPanel?.querySelector('.radio-directory-row');
    const transport = this._radioPanel?.querySelector('.radio-transport');
    if (
      !contextPanel ||
      contextPanel.classList.contains('collapsed') ||
      !scroller ||
      !directory ||
      !transport ||
      !this._radioState?.enabled
    )
      return false;

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (!this._radioState?.enabled || !trigger?.isConnected) return false;

    const viewport = scroller.getBoundingClientRect();
    const directoryRect = directory.getBoundingClientRect();
    const transportRect = transport.getBoundingClientRect();
    const margin = 10;
    const minimum =
      scroller.scrollTop + transportRect.bottom - (viewport.bottom - margin);
    const maximum =
      scroller.scrollTop + directoryRect.top - (viewport.top + margin);
    const desired =
      minimum <= maximum
        ? Math.min(Math.max(scroller.scrollTop, minimum), maximum)
        : minimum;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    if (Math.abs(next - scroller.scrollTop) < 1) return false;
    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    )?.matches;
    scroller.scrollTo({
      top: next,
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    return true;
  }

  /**
   * Bring the embedded Radio section into the expanded Context scroller.
   * This never changes Radio power, playback, selection, or Context mode.
   * @param {{focusTarget?: HTMLElement|null}} [options]
   * @returns {Promise<boolean>} Whether the internal scroller moved.
   */
  async _revealRadioPanelInsideContext({ focusTarget = null } = {}) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    if (
      !contextPanel ||
      contextPanel.classList.contains('collapsed') ||
      !scroller ||
      !this._radioPanel ||
      this._radioPanel.classList.contains('collapsed')
    )
      return false;

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (
      contextPanel.classList.contains('collapsed') ||
      this._radioPanel.classList.contains('collapsed')
    )
      return false;

    const viewport = scroller.getBoundingClientRect();
    const radioRect = this._radioPanel.getBoundingClientRect();
    const desired = scroller.scrollTop + radioRect.top - viewport.top - 10;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    const moved = Math.abs(next - scroller.scrollTop) >= 1;
    if (moved) {
      const reducedMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      )?.matches;
      scroller.scrollTo({
        top: next,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    }
    focusTarget?.focus?.({ preventScroll: true });
    return moved;
  }

  /** Keep the Context header Radio shortcut truthful for its current route. */
  _syncContextRadioLauncherState() {
    if (!this._contextRadioToggleBtn) return;
    const contextPanel = document.getElementById('global-context-panel');
    const contextExpanded = Boolean(
      contextPanel && !contextPanel.classList.contains('collapsed'),
    );
    if (contextExpanded) {
      const radioExpanded = Boolean(
        this._radioPanel && !this._radioPanel.classList.contains('collapsed'),
      );
      this._contextRadioToggleBtn.setAttribute('aria-controls', 'radio-panel');
      this._contextRadioToggleBtn.setAttribute(
        'aria-expanded',
        String(radioExpanded),
      );
      const label = radioExpanded
        ? 'Go to expanded Radio section'
        : 'Expand Radio section in Context';
      this._contextRadioToggleBtn.setAttribute('aria-label', label);
      this._contextRadioToggleBtn.title = label;
      return;
    }
    const compactOpen = Boolean(
      this._contextRadioDock?.classList.contains('disclosure-open'),
    );
    this._contextRadioToggleBtn.setAttribute(
      'aria-controls',
      'context-radio-mini',
    );
    this._contextRadioToggleBtn.setAttribute(
      'aria-expanded',
      String(compactOpen),
    );
    const action = compactOpen ? 'Close' : 'Open';
    this._contextRadioToggleBtn.setAttribute(
      'aria-label',
      `${action} compact Radio controls`,
    );
    this._contextRadioToggleBtn.title = `${action} compact Radio controls`;
  }

  /** Render Radio state without making playback or Context decisions. */
  _renderRadioState(state) {
    if (!state || !this._radioPanel) return;
    const lifecycle =
      this._dataManager?.getLayerLifecycleState?.('radio') || null;
    const lifecycleState =
      lifecycle?.lifecycleState || (state.enabled ? 'enabled' : 'disabled');
    state = {
      ...state,
      enabled: lifecycle ? lifecycle.enabled : state.enabled,
      lifecycleState,
      lifecycleUncertain: lifecycle?.uncertain || false,
    };
    this._radioState = state;
    const enabled = Boolean(state.enabled);
    const transitioning =
      lifecycleState === 'enabling' || lifecycleState === 'disabling';
    const uncertain = Boolean(state.lifecycleUncertain);
    const interactive = enabled && !transitioning && !uncertain;
    const selected = state.selected || null;
    const hasStations = state.filteredCount > 0;
    const activePlayback = ['playing', 'buffering'].includes(state.audioState);
    document
      .getElementById('title-bar')
      ?.classList.toggle('radio-broadcasting', state.audioState === 'playing');
    this._radioPanel.classList.toggle('radio-enabled', enabled);
    this._radioPanel.classList.toggle('lifecycle-uncertain', uncertain);
    this._contextRadioDock?.classList.toggle('active', enabled);
    if (this._contextRadioToggleBtn) {
      this._contextRadioToggleBtn.classList.toggle('active', enabled);
    }
    this._syncContextRadioLauncherState();
    this._radioLayerState?.classList.toggle('active', enabled);
    if (this._radioLayerState) {
      this._radioLayerState.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : uncertain
          ? 'UNCERTAIN'
          : state.loading
            ? 'SYNC'
            : enabled
              ? `${state.filteredCount}/${state.stationCount}`
              : 'OFF';
    }
    if (this._radioEnableBtn) {
      this._radioEnableBtn.classList.toggle('active', enabled);
      this._radioEnableBtn.setAttribute('aria-pressed', String(enabled));
      this._radioEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : uncertain
          ? 'RECONCILE'
          : enabled
            ? 'DISABLE'
            : 'ENABLE';
      this._radioEnableBtn.setAttribute(
        'aria-label',
        uncertain
          ? 'Reconcile Radio — lifecycle uncertain'
          : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      this._radioEnableBtn.disabled = false;
      this._radioEnableBtn.setAttribute('aria-disabled', String(transitioning));
      this._radioEnableBtn.setAttribute('aria-busy', String(transitioning));
    }
    if (this._contextRadioMiniEnableBtn) {
      this._contextRadioMiniEnableBtn.classList.toggle('active', enabled);
      this._contextRadioMiniEnableBtn.setAttribute(
        'aria-pressed',
        String(enabled),
      );
      this._contextRadioMiniEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : uncertain
          ? 'RECONCILE'
          : enabled
            ? 'DISABLE'
            : 'ENABLE';
      this._contextRadioMiniEnableBtn.setAttribute(
        'aria-label',
        uncertain
          ? 'Reconcile Radio — lifecycle uncertain'
          : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      this._contextRadioMiniEnableBtn.disabled = false;
      this._contextRadioMiniEnableBtn.setAttribute(
        'aria-disabled',
        String(transitioning),
      );
      this._contextRadioMiniEnableBtn.setAttribute(
        'aria-busy',
        String(transitioning),
      );
    }
    if (this._cockpitRadioEnableBtn) {
      this._cockpitRadioEnableBtn.classList.toggle('active', enabled);
      this._cockpitRadioEnableBtn.setAttribute('aria-pressed', String(enabled));
      this._cockpitRadioEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : uncertain
          ? 'RECONCILE'
          : enabled
            ? 'DISABLE'
            : 'ENABLE';
      this._cockpitRadioEnableBtn.setAttribute(
        'aria-label',
        uncertain
          ? 'Reconcile Radio — lifecycle uncertain'
          : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      this._cockpitRadioEnableBtn.disabled = false;
      this._cockpitRadioEnableBtn.setAttribute(
        'aria-disabled',
        String(transitioning),
      );
      this._cockpitRadioEnableBtn.setAttribute(
        'aria-busy',
        String(transitioning),
      );
    }

    if (this._radioFilter) {
      const prior = state.filter || 'all';
      const categorySignature = state.categories
        .map((category) => `${category.id}:${category.count}:${category.color}`)
        .join('|');
      if (categorySignature !== this._radioCategorySignature) {
        this._radioFilter.replaceChildren(
          ...state.categories.map((category) => {
            const option = document.createElement('option');
            option.value = category.id;
            option.textContent = `● ${category.label} (${category.count})`;
            option.dataset.radioColor = category.color;
            option.style.color = category.color;
            option.setAttribute(
              'aria-label',
              `${category.label} (${category.count})`,
            );
            return option;
          }),
        );
        this._radioCategorySignature = categorySignature;
      }
      this._radioFilter.value = prior;
      const activeCategory = state.categories.find(
        (category) => category.id === prior,
      );
      this._radioFilter.style.color = activeCategory?.color || '';
      this._radioFilter.disabled = !interactive || !state.stationCount;
    }

    const tunerAvailable = interactive && state.filteredCount > 0;
    if (this._radioTuner) this._radioTuner.hidden = !tunerAvailable;
    if (this._radioTunerSlider)
      this._radioTunerSlider.disabled = !tunerAvailable;
    if (this._radioTunerBandLabel) {
      const activeCategory = state.categories.find(
        (category) => category.id === state.filter,
      );
      this._radioTunerBandLabel.textContent =
        state.filter === 'all'
          ? 'DIRECTORY BAND'
          : `${String(activeCategory?.label || state.filter).toUpperCase()} BAND`;
    }
    this._radioTuner?.classList.toggle(
      'is-static',
      Boolean(state.tuningStatic),
    );
    if (tunerAvailable) this._refreshRadioTunerBand?.();
    if (!tunerAvailable && this._radioTunerDragging) {
      this._radioTunerDragging = false;
      this._radioTunerDragSnapshot = null;
      this._radioTunerStations = [];
      this._radioTuner?.classList.remove('is-static', 'is-dragging');
    }
    if (!tunerAvailable) {
      this._radioTunerStations = [];
      this._radioTunerPool = [];
      this._radioTunerBandSignature = '';
      this._radioTunerSelectedId = null;
    }

    if (this._radioStationName)
      this._radioStationName.textContent =
        selected?.name || 'NO STATION SELECTED';
    if (this._radioStationMeta) {
      const place = selected
        ? [selected.state, selected.countryCode].filter(Boolean).join(' · ')
        : '';
      const signal = selected
        ? [selected.codec, selected.bitrate ? `${selected.bitrate} kbps` : '']
            .filter(Boolean)
            .join(' · ')
        : '';
      this._radioStationMeta.textContent = selected
        ? [place, signal].filter(Boolean).join('  /  ') ||
          'Directory metadata only'
        : state.loading
          ? 'Loading station directory…'
          : 'Choose a globe marker or use next.';
    }
    if (this._radioStationTags) {
      const tags = Array.isArray(selected?.tags)
        ? selected.tags.slice(0, 8)
        : [];
      this._radioStationTags.textContent = tags.length
        ? `TAGS · ${tags.join(' · ')}`
        : '';
    }
    if (this._radioStationHomepage) {
      const homepage = selected?.homepage || '';
      this._radioStationHomepage.hidden = !homepage;
      if (homepage) this._radioStationHomepage.href = homepage;
      else this._radioStationHomepage.removeAttribute('href');
    }

    if (this._radioPrevBtn)
      this._radioPrevBtn.disabled = !interactive || !hasStations;
    if (this._radioNextBtn)
      this._radioNextBtn.disabled = !interactive || !hasStations;
    if (this._contextRadioMiniPrevBtn)
      this._contextRadioMiniPrevBtn.disabled = !interactive || !hasStations;
    if (this._contextRadioMiniNextBtn)
      this._contextRadioMiniNextBtn.disabled = !interactive || !hasStations;
    if (this._cockpitRadioPrevBtn)
      this._cockpitRadioPrevBtn.disabled = !interactive || !hasStations;
    if (this._cockpitRadioNextBtn)
      this._cockpitRadioNextBtn.disabled = !interactive || !hasStations;
    if (this._radioPlayBtn) {
      const action = activePlayback
        ? 'Pause'
        : state.audioState === 'paused'
          ? 'Resume'
          : 'Play';
      this._radioPlayBtn.disabled = !interactive || !hasStations;
      this._radioPlayBtn.classList.toggle('active', activePlayback);
      this._radioPlayBtn.textContent = action.toUpperCase();
      this._radioPlayBtn.setAttribute(
        'aria-label',
        `${action} ${selected ? 'selected' : 'nearest'} radio station`,
      );
    }
    if (this._contextRadioMiniPlayBtn) {
      const action = activePlayback
        ? 'Pause'
        : state.audioState === 'paused'
          ? 'Resume'
          : 'Play';
      this._contextRadioMiniPlayBtn.disabled = !interactive || !hasStations;
      this._contextRadioMiniPlayBtn.classList.toggle('active', activePlayback);
      this._contextRadioMiniPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
      this._contextRadioMiniPlayBtn.setAttribute(
        'aria-label',
        `${action} ${selected ? 'selected' : 'nearest'} radio station`,
      );
      this._contextRadioMiniPlayBtn.title = action;
    }
    if (this._cockpitRadioPlayBtn) {
      const action = activePlayback
        ? 'Pause'
        : state.audioState === 'paused'
          ? 'Resume'
          : 'Play';
      this._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
      this._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
      this._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
      this._cockpitRadioPlayBtn.setAttribute(
        'aria-label',
        `${action} ${selected ? 'selected' : 'nearest'} radio station`,
      );
      this._cockpitRadioPlayBtn.title = action;
    }
    if (this._radioStopBtn)
      this._radioStopBtn.disabled =
        !interactive || state.audioState === 'stopped';
    if (this._radioVolume) this._radioVolume.disabled = !interactive;
    if (this._radioVolume && document.activeElement !== this._radioVolume) {
      this._radioVolume.value = String(Math.round(state.volume * 100));
      if (this._radioVolumeValue)
        this._radioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (
      this._contextRadioMiniVolume &&
      document.activeElement !== this._contextRadioMiniVolume
    ) {
      this._contextRadioMiniVolume.value = String(
        Math.round(state.volume * 100),
      );
    }
    if (this._contextRadioMiniVolume)
      this._contextRadioMiniVolume.disabled = !interactive;
    if (this._contextRadioMiniVolumeValue) {
      this._contextRadioMiniVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (
      this._cockpitRadioVolume &&
      document.activeElement !== this._cockpitRadioVolume
    ) {
      this._cockpitRadioVolume.value = String(Math.round(state.volume * 100));
    }
    if (this._cockpitRadioVolume)
      this._cockpitRadioVolume.disabled = !interactive;
    if (this._cockpitRadioVolumeValue) {
      this._cockpitRadioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (this._contextRadioMiniStation) {
      this._contextRadioMiniStation.textContent = uncertain
        ? 'RADIO STATE UNCERTAIN'
        : selected?.name ||
          (state.loading ? 'SYNCING DIRECTORY' : 'RADIO READY');
    }
    if (this._cockpitRadioStation) {
      this._cockpitRadioStation.textContent = uncertain
        ? 'UNCERTAIN'
        : selected?.name || (state.loading ? 'SYNCING' : 'READY');
    }
    if (this._radioPlaybackState) {
      const catalogSuffix = state.degraded
        ? state.stale
          ? ' · stale/degraded directory'
          : ' · degraded directory'
        : state.stale
          ? ' · stale directory'
          : '';
      const outsideFilter =
        selected && state.selectedIndex < 0 ? ' · outside current filter' : '';
      const messages = {
        stopped: enabled
          ? 'Ready — playback starts only from your action'
          : 'Radio off',
        loading: 'Connecting directly to broadcaster…',
        buffering: 'Buffering broadcaster stream…',
        playing: `Playing ${selected?.name || 'station'}`,
        paused: `Paused ${selected?.name || 'station'}`,
        error: state.audioError || 'Broadcaster stream unavailable',
      };
      const voiceSuffix = state.voiceDucked
        ? ' · muted during voice interaction'
        : state.voiceRestoring
          ? ' · restoring volume after voice'
          : '';
      const tuningSuffix = state.tuningAwaitingStationId
        ? state.audioState === 'error'
          ? ' · static indicates no broadcaster audio'
          : ' · tuning static until broadcaster starts'
        : '';
      const unavailable = state.tuningUnavailableStationId
        ? 'Station unavailable after directory refresh — choose another channel'
        : null;
      const lifecycleMessage = transitioning
        ? lifecycleState === 'enabling'
          ? 'Radio is enabling…'
          : 'Radio is disabling…'
        : null;
      const uncertainMessage = uncertain
        ? 'Radio lifecycle is uncertain — use Enable or Disable to reconcile'
        : null;
      this._radioPlaybackState.textContent = `${uncertainMessage || unavailable || lifecycleMessage || state.error || messages[state.audioState] || 'Ready'}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
      this._radioPlaybackState.classList.toggle(
        'error',
        Boolean(
          uncertainMessage ||
            unavailable ||
            state.error ||
            state.audioState === 'error',
        ),
      );
    }
    if (
      !enabled &&
      !transitioning &&
      !this._preservePanelStateDuringLayerClear &&
      !this._radioPanel.classList.contains('collapsed')
    ) {
      this.setPanelCollapsed('radio-panel', true);
    }
    this._scheduleRightPanelLayout();
  }

  /**
   * Undo the panel's wiring when StyleManager is disposed: stop listening to
   * the radio layer and the tuner, end any tuning and clear the broadcasting
   * mark from the title bar.
   */
  _disposeRadioPanel() {
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    this._radioTunerAbort?.abort();
    this._radioTunerAbort = null;
    this._radioTunerBandPinnedForNavigation = false;
    this._radioTunerDragSnapshot = null;
    this._radioTunerPool = [];
    this._radioTunerCameraRemove?.();
    this._radioTunerCameraRemove = null;
    this._refreshRadioTunerBand = null;
    document
      .getElementById('title-bar')
      ?.classList.remove('radio-broadcasting');
    radioLayer.endTuning();
    if (this._radioSelectedHandler) {
      document.removeEventListener(
        'gev:radio-selected',
        this._radioSelectedHandler,
      );
      this._radioSelectedHandler = null;
    }
  }
}
