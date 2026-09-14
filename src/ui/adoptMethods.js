// @ts-check
/**
 * How StyleManager takes on the panels that moved out of src/ui.js (#46).
 *
 * A panel module declares a class that is never constructed. Its methods are
 * copied onto StyleManager's prototype, so they run as StyleManager methods,
 * on StyleManager's state, exactly as they did when they sat in its class
 * body. The panel's code lives in its own module; its state stays with the
 * StyleManager that owns the panel's lifecycle.
 */

/**
 * Copies every method, getter and setter of `panelClass` onto `hostClass`.
 * @param {Function} hostClass - The class that runs the methods.
 * @param {Function} panelClass - The class that declares them.
 * @throws {Error} When the host already has a member of the same name, so a
 *   panel can never silently replace another panel's method.
 */
export function adoptMethods(hostClass, panelClass) {
  const members = Object.getOwnPropertyDescriptors(panelClass.prototype);
  for (const [name, descriptor] of Object.entries(members)) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(hostClass.prototype, name)) {
      throw new Error(`${hostClass.name} already has ${name}`);
    }
    Object.defineProperty(hostClass.prototype, name, descriptor);
  }
}
