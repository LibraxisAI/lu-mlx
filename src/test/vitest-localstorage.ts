/**
 * Node 22+ (this machine: Node 26) exposes a `localStorage` getter that is
 * undefined unless `--localstorage-file` is passed. Zustand persist then
 * calls `storage.setItem` on that undefined value, and the supabase
 * keychain fallback does the same with `getItem`. That is the 3-error
 * cluster in `make test`, not a product regression.
 *
 * `--localstorage-file` would share one JSON file across vitest workers
 * and leak store state between files. This in-memory Storage is the same
 * Map-backed shape store tests already install by hand
 * (`createStore.test.ts`, `lu-engine-name.test.ts`).
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

function install(name: 'localStorage' | 'sessionStorage', storage: Storage): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
  const win = (globalThis as { window?: Window & typeof globalThis }).window
  if (win && win !== globalThis) {
    Object.defineProperty(win, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: storage,
    })
  }
}

install('localStorage', memoryStorage())
install('sessionStorage', memoryStorage())
