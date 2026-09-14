// @ts-check
const STORE_KEY = '__gevContextStore';

/**
 * One selectable thing that voice and the Cockpit can talk about: the metadata
 * its layer registered, plus the Cesium entity, or a stand-in carrier for a
 * tracking layer's subject.
 * @typedef {object} ContextRecord
 * @property {string} id Stable id, also written to `entity.__gevContextId`.
 * @property {string} [layerId] The layer that owns the record.
 * @property {{ show?: boolean, __gevContextId?: string }} entity
 * @property {{ show?: boolean }} [dataSource] A hidden source reads as
 *   inactive.
 * @property {number} updatedAt When the record was last registered, in ms.
 */

/**
 * The shared context store. It lives on `window`, so every module and the
 * voice tools see one copy.
 * @typedef {object} ContextStore
 * @property {Map<string, ContextRecord>} entities Records by id.
 * @property {string | null} selectedEntityId
 * @property {number | null} selectedAt When the selection was made, in ms.
 */

/**
 * Fields a layer registers for one entity. `id` is required; a record keeps
 * any other field it is given.
 * @typedef {{ id: string, layerId?: string } & Record<string, unknown>} ContextMetadata
 */

/**
 * The part of the data manager that says whether a record's layer is on.
 * @typedef {object} ContextLayerManager
 * @property {(layerId: string) => boolean} isEnabled
 */

/** @returns {ContextStore} */
function createStore() {
  return {
    entities: new Map(),
    selectedEntityId: null,
    selectedAt: null,
  };
}

/** @returns {ContextStore} */
export function getContextStore() {
  const host = /** @type {Window & { __gevContextStore?: ContextStore }} */ (
    window
  );
  if (!host[STORE_KEY]) {
    host[STORE_KEY] = createStore();
  }
  return host[STORE_KEY];
}

/**
 * Is there a window to hang the store on?
 *
 * The tracking-subject helpers run inside the aircraft layers' per-poll
 * refresh, which unit tests drive with no DOM at all. Without this guard the
 * bare `window` read throws mid-poll and takes the rest of the refresh with
 * it.
 * @returns {boolean} True when the store is reachable.
 */
function hasContextHost() {
  return typeof window !== 'undefined' && Boolean(window);
}

/**
 * Register one entity's context record, replacing an earlier record with the
 * same id.
 * @param {{ __gevContextId?: string, show?: boolean }} entity A Cesium entity,
 *   or a stand-in carrier for a tracking layer's subject.
 * @param {ContextMetadata} metadata
 * @returns {ContextRecord | null}
 */
export function registerEntityContext(entity, metadata) {
  if (!entity || !metadata?.id) return null;
  const store = getContextStore();
  const record = {
    ...metadata,
    entity,
    updatedAt: Date.now(),
  };
  entity.__gevContextId = metadata.id;
  store.entities.set(metadata.id, record);
  return record;
}

/**
 * Select an entity's context record and announce it with
 * `gev:entity-selected`.
 * @param {ContextRecord['entity'] | null | undefined} entity The picked
 *   entity.
 * @returns {ContextRecord | null} The selected record, or null when the entity
 *   has none.
 */
export function selectEntityContext(entity) {
  const store = getContextStore();
  const contextId = entity?.__gevContextId;
  if (!contextId || !store.entities.has(contextId)) return null;
  store.selectedEntityId = contextId;
  store.selectedAt = Date.now();
  const record = /** @type {ContextRecord} */ (store.entities.get(contextId));
  window.dispatchEvent(
    new CustomEvent('gev:entity-selected', { detail: record }),
  );
  return record;
}

/**
 * Publish the live subject of a TRACKING layer (aircraft) into the shared
 * selection slot.
 *
 * Selecting a contact is a click-selection like any other — voice's
 * `scope:'selected'` and the Cockpit's selected-target lookup both read this
 * one slot, so a tracking layer that stays out of it is invisible to them
 * even while its readout card is on screen.
 *
 * Deliberately does NOT dispatch `gev:entity-selected`: tracking layers own a
 * separate publication lane (`gev:awareness-subject-selected`) that the
 * readout and Contacts panel already consume, and a second event for the same
 * click would make those two surfaces fight over one subject.
 *
 * A tracking layer has at most one subject, so any earlier record it left
 * behind is dropped — its feed refreshes continuously and a frozen snapshot
 * must never reach the visible-entity scan.
 *
 * @param {ContextMetadata} metadata Record fields; `id` and `layerId` required.
 * @returns {ContextRecord | null} The stored record, or null when identity is
 *   missing.
 */
export function selectTrackedSubjectContext(metadata) {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  for (const [key, record] of store.entities) {
    if (record?.layerId === metadata.layerId && key !== id)
      store.entities.delete(key);
  }
  // Reuse the existing carrier so a per-poll refresh does not churn identity.
  const carrier = store.entities.get(id)?.entity || { __gevContextId: id };
  const record = registerEntityContext(carrier, { ...metadata, id });
  if (!record) return null;
  store.selectedEntityId = id;
  store.selectedAt = Date.now();
  return record;
}

/**
 * Refresh a tracking layer's subject in place WITHOUT claiming the selection.
 *
 * The per-poll position/identity refresh must not resurrect a subject the
 * operator has since replaced by clicking something else.
 * @param {ContextMetadata} metadata Record fields; `id` and `layerId` required.
 * @returns {ContextRecord | null} The stored record, or null when it is not
 *   registered.
 */
export function refreshTrackedSubjectContext(metadata) {
  if (!hasContextHost() || !metadata?.id || !metadata?.layerId) return null;
  const store = getContextStore();
  const id = String(metadata.id);
  const existing = store.entities.get(id);
  if (!existing || existing.layerId !== metadata.layerId) return null;
  return registerEntityContext(existing.entity, { ...metadata, id });
}

/**
 * Drop a tracking layer's subject when the operator deselects it.
 *
 * Pairs with {@link selectTrackedSubjectContext} and stays event-free for the
 * same reason: `gev:awareness-subject-cleared` is the tracking layers' lane.
 * @param {string} layerId Owning layer.
 * @returns {void}
 */
export function clearTrackedSubjectContext(layerId) {
  if (!hasContextHost() || !layerId) return;
  const store = getContextStore();
  for (const [key, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(key);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
  }
}

/**
 * The selected context record while it is still active. A selection that is
 * no longer active is cleared.
 * @param {{ dataManager?: ContextLayerManager | null }} [options]
 *   `dataManager` says whether the record's layer is enabled.
 * @returns {ContextRecord | null}
 */
export function getSelectedEntityContext({ dataManager = null } = {}) {
  const store = getContextStore();
  if (!store.selectedEntityId) return null;
  const record = store.entities.get(store.selectedEntityId);
  if (!record || !isContextRecordActive(record, dataManager)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    return null;
  }
  return record;
}

/**
 * Drop the selected context record owned by a layer.
 * @param {string} layerId Owning layer.
 * @param {object} [options] Clear origin.
 * @param {boolean} [options.evicted=false] The record aged out of its feed
 *   rather than being deselected. Readouts that stay on screen hold their
 *   last-known values for an eviction and only tear down on a deliberate clear.
 */
export function clearSelectedEntityContextForLayer(
  layerId,
  { evicted = false } = {},
) {
  const store = getContextStore();
  if (!store.selectedEntityId) return;
  const record = store.entities.get(store.selectedEntityId);
  if (record?.layerId === layerId) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    window.dispatchEvent(
      new CustomEvent('gev:entity-selection-cleared', {
        detail: { layerId, reason: evicted ? 'evicted' : 'deliberate' },
      }),
    );
  }
}

/**
 * Remove obsolete context records when a viewport-scoped layer refreshes.
 * @param {string} layerId Owning layer.
 */
export function removeEntityContextsForLayer(layerId) {
  const store = getContextStore();
  for (const [id, record] of store.entities) {
    if (record?.layerId === layerId) store.entities.delete(id);
  }
  if (store.selectedEntityId && !store.entities.has(store.selectedEntityId)) {
    store.selectedEntityId = null;
    store.selectedAt = null;
    // A viewport refresh dropped the record out from under the selection —
    // the user did not deselect anything.
    window.dispatchEvent(
      new CustomEvent('gev:entity-selection-cleared', {
        detail: { layerId, reason: 'evicted' },
      }),
    );
  }
}

/**
 * Is a record still live: its entity and data source shown, and its layer
 * enabled?
 * @param {ContextRecord | null | undefined} record
 * @param {ContextLayerManager | null} [dataManager=null] Without it, the
 *   layer is not checked.
 * @returns {boolean}
 */
export function isContextRecordActive(record, dataManager = null) {
  if (!record) return false;
  if (record.entity?.show === false) return false;
  if (record.dataSource && record.dataSource.show === false) return false;
  if (dataManager && record.layerId && !dataManager.isEnabled(record.layerId))
    return false;
  return true;
}
