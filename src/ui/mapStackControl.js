// src/ui/mapStackControl.js — the map source control: the chip row of the
// approved basemap stacks, switching between them, and a status that follows
// the controller rather than the click. setMapStack() is the control voice
// tools and scenes call.
//
// These are StyleManager methods, kept here and adopted by StyleManager (see
// src/ui/adoptMethods.js); they run on its state.
import { renderMapStackChips, syncMapStackChips } from '../mapStackChips.js';

export class MapStackControl {
  /**
   * Renders the owner-approved map stack chip row from the matching controller
   * entries. Cesium ion/Bing chips remain keyboard-focusable but unavailable,
   * with an accessible explanation, until a CESIUM_ION_TOKEN is configured.
   * @returns {void}
   */
  _initMapStackControl() {
    if (!this._mapStackChips || !this.mapStackController) return;

    if (!this._mapStackChangeHandler) {
      // Provider-driven transitions (notably Esri tile-error fallback) do not
      // pass through `_setMapStack()`. Follow the controller's existing public
      // event so the lit tile, the status line, AND the durable share state all
      // describe the rendered source — without the share sync, a silent
      // fallback leaves copyLink() encoding a stack that is no longer shown.
      this._mapStackChangeHandler = (event) => {
        this._renderMapStackState(event.detail);
        this._syncShareState();
      };
      window.addEventListener(
        'gev:map-stack-changed',
        this._mapStackChangeHandler,
      );
    }

    renderMapStackChips(
      this._mapStackChips,
      this.mapStackController.getStacks(),
      {
        activeId: this.mapStackController.getActiveId(),
        onSelect: (stackId) => {
          this._setMapStack(stackId);
        },
      },
    );

    this._renderMapStackState(this.mapStackController.getState());
  }

  /**
   * Switches the active map/globe source stack.
   * @param {string} stackId - Map stack id.
   * @param {object} [options]
   * @param {boolean} [options.syncShare=true] - Whether to update the share link.
   * @returns {Promise<void>}
   */
  async _setMapStack(stackId, { syncShare = true } = {}) {
    if (!this.mapStackController) return;
    if (syncShare) this.shareLinkManager?.claimRestoreLane?.('map');
    const before = this.mapStackController.getActiveId();
    this._renderMapStackState(this.mapStackController.getState('switching'));
    const state = await this.mapStackController.setStack(stackId);
    this._renderMapStackState(state);

    if (state?.activeId === before && stackId !== before && state?.lastError) {
      this._showToast(state.lastError);
    }
    if (syncShare) this._syncShareState();
  }

  /**
   * Syncs the map stack chip row and status chip with controller state. The
   * lit chip always follows `state.activeId`, never the click — a rejected or
   * superseded switch therefore leaves the genuinely active stack lit.
   * @param {object} state - Map stack controller state.
   * @returns {void}
   */
  _renderMapStackState(state) {
    if (!state) return;
    syncMapStackChips(this._mapStackChips, state.activeId);
    if (this._mapStackStatus) {
      const stack = state.activeStack;
      const label =
        state.status === 'switching'
          ? '...'
          : stack?.shortLabel || stack?.label || 'MAP';
      this._mapStackStatus.textContent = label;
      this._mapStackStatus.classList.toggle('warn', !!state.lastError);
    }
  }

  /**
   * Switches the basemap stack and reports whether the switch landed.
   * @param {string} stackId - One of mapStackController.getStacks() ids.
   * @returns {Promise<{ok: boolean, activeStack?: string, error?: string|null, available?: string[]}>}
   */
  async setMapStack(stackId) {
    if (!this.mapStackController) {
      return { ok: false, error: 'Map stack controller unavailable' };
    }
    const stacks = this.mapStackController.getStacks();
    const target = stacks.find((stack) => stack.id === stackId);
    if (!target) {
      return {
        ok: false,
        error: `Unknown map stack: ${stackId}`,
        available: stacks.map((s) => s.id),
      };
    }
    if (!target.available) {
      return {
        ok: false,
        error: `${target.label} requires a Cesium ion token`,
        activeStack: this.mapStackController.getActiveId(),
      };
    }
    await this._setMapStack(stackId);
    const state = this.mapStackController.getState();
    const landed = state.activeId === stackId;
    return {
      ok: landed,
      activeStack: state.activeId,
      error: landed ? null : state.lastError || 'Map stack did not switch',
    };
  }
}
