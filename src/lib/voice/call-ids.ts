// Tool call ids from the model, made safe for the app.
//
// The id of a tool call is chosen by the model's server. Local servers send
// short ids from a tame alphabet, cloud models send whatever they like
// ("functions.shell:0", "call_abc|fc_123", ids with dots, colons or slashes).
// The app's executor, the transcript and the approval card all key on that id,
// so the voice tool bridge used to refuse every call whose id was not plain
// `[A-Za-z0-9_-]`, and the whole session ended on the first tool call of such
// a model.
//
// The id the server sent stays the identity of the call: the duplicate guard
// is keyed by it, and the result goes back under it. Inside the app the call
// travels under an alias from the tame alphabet. Two different ids never share
// an alias, and one id always gets the same alias, so a call that arrives
// twice is still recognised as one call.

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/

/** The longest id accepted from the wire. Longer is not an id, it is a payload. */
export const MAX_WIRE_ID_CHARS = 512

export class CallIdMap {
  private readonly aliasByWire = new Map<string, string>()
  private readonly taken = new Set<string>()
  private next = 1

  /**
   * The alias for an id from the wire, or null when the value cannot be an id
   * at all (not a string, empty, or absurdly long).
   */
  alias(wireId: unknown): string | null {
    if (typeof wireId !== 'string' || wireId.length === 0 || wireId.length > MAX_WIRE_ID_CHARS) return null
    const known = this.aliasByWire.get(wireId)
    if (known) return known
    let alias = wireId
    // An id that is already safe keeps its name, unless an earlier generated
    // alias happens to carry it.
    if (!SAFE_ID.test(alias) || this.taken.has(alias)) {
      do {
        alias = `call-${this.next++}`
      } while (this.taken.has(alias))
    }
    this.aliasByWire.set(wireId, alias)
    this.taken.add(alias)
    return alias
  }

  get size(): number {
    return this.aliasByWire.size
  }

  clear(): void {
    this.aliasByWire.clear()
    this.taken.clear()
    this.next = 1
  }
}
