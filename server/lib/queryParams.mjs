/**
 * A query parameter as a finite number, or null when it is missing, blank or
 * not a finite number.
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {number|null}
 */
export function requiredFiniteQueryNumber(params, key) {
  const value = params.get(key);
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
