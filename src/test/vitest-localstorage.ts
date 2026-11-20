/**
 * Node 22+ (this machine: Node 26) exposes a `localStorage` getter that is
 * undefined unless `--localstorage-file` is passed. Zustand persist then
 * calls `storage.setItem` on that undefined value, and the supabase
 * keychain fallback does the same with `getItem`. That is the 3-error
 * cluster in `make test`, not a product regression.
 *
 * In `@vitest-environment jsdom`, Vitest's `populateGlobal` skips copying
 * `window.localStorage` onto `globalThis` when `'localStorage' in globalThis`
 * is already true on Node 26, so check `window[name]` first and mirror jsdom's
 * real `Storage` onto `globalThis[name]` instead of replacing it (which keeps
 * `Storage.prototype` spies/patches and `Object.keys(localStorage)` working).
 */
function isWorkingStorage(candidate: unknown): candidate is Storage {
  try {
    const s = candidate as Partial<Storage> | undefined
    return (
      typeof s?.getItem === 'function' &&
      typeof s?.setItem === 'function' &&
      typeof s?.removeItem === 'function' &&
      typeof s?.clear === 'function' &&
      typeof s?.key === 'function'
    )
  } catch {
    return false
  }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  const proto: Omit<Storage, 'length'> = {
    getItem: (key: string) => (map.has(String(key)) ? map.get(String(key))! : null),
    setItem: (key: string, value: string) => {
      map.set(String(key), String(value))
    },
    removeItem: (key: string) => {
      map.delete(String(key))
    },
    clear: () => {
      map.clear()
    },
    key: (index: number) => [...map.keys()][index] ?? null,
  }
  const base = Object.create(proto) as Storage
  Object.defineProperty(base, 'length', {
    get: () => map.size,
    enumerable: false,
    configurable: true,
  })
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target) && map.has(prop)) {
        return map.get(prop)
      }
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      return (typeof prop === 'string' && map.has(prop)) || Reflect.has(target, prop)
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string' && !(prop in target)) {
        map.delete(prop)
        return true
      }
      return Reflect.deleteProperty(target, prop)
    },
    ownKeys() {
      return [...map.keys()]
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && map.has(prop)) {
        return {
          value: map.get(prop),
          writable: true,
          enumerable: true,
          configurable: true,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const g = globalThis as unknown as {
    jsdom?: { window?: Record<string, unknown> }
    window?: Record<string, unknown>
  }
  const jsdomWin = g.jsdom?.window
  const win = g.window
  const sourceWin =
    jsdomWin && isWorkingStorage(jsdomWin[name])
      ? jsdomWin
      : win && win !== (globalThis as unknown) && isWorkingStorage(win[name])
        ? win
        : undefined
  if (sourceWin) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: sourceWin[name],
    })
    return
  }
  if (isWorkingStorage((g as unknown as Record<string, unknown>)[name])) {
    return
  }
  const storage = memoryStorage()
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
  if (win && win !== (globalThis as unknown)) {
    Object.defineProperty(win, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: storage,
    })
  }
}

install('localStorage')
install('sessionStorage')
