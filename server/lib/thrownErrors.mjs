/**
 * Reading what a `catch` caught. JavaScript can throw any value, so a caught
 * value is `unknown` until it is checked; these helpers read from it only when
 * it is an Error. fetch(), Node's fs and child_process, and the proxies' own
 * code all throw Errors.
 */

/**
 * The message of a thrown Error, or undefined for any other value.
 * @param {unknown} error
 * @returns {string|undefined}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : undefined;
}

/**
 * One property of a thrown Error: Node's `code`, its `name`, or a field a
 * proxy attached with Object.assign. Undefined for any other value.
 * @param {unknown} error
 * @param {string} key
 * @returns {unknown}
 */
export function errorField(error, key) {
  return error instanceof Error ? Reflect.get(error, key) : undefined;
}
