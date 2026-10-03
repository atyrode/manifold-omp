/**
 * One SDK namespace with some operations replaced. Every other member is the module's own,
 * bound to it, because SDK modules keep their state in private fields a proxy cannot reach.
 *
 * OMP 18.4 moved AuthStorage's operations onto namespace modules (`credentials`, `keys`,
 * `oauth`, `usage`, ...). The stock broker and gateway call those namespaces, so native
 * wrappers replace an operation there, never on the facade the SDK no longer calls.
 */
export function namespaceView<T extends object>(module: T, overrides: Partial<T>): T {
  return new Proxy(module, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof T];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Views keyed by SDK module, so a replaced store gets a fresh view and a request allocates none. */
export class NamespaceViews {
  readonly #views = new WeakMap<object, object>();
  view<T extends object>(module: T, build: (module: T) => Partial<T>): T {
    let view = this.#views.get(module) as T | undefined;
    if (!view) {
      view = namespaceView(module, build(module));
      this.#views.set(module, view);
    }
    return view;
  }
}
