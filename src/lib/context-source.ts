/**
 * Woher die Zahl kommt, die als Kontextfenster angezeigt und verrechnet wird.
 *
 * GH #129 (2026-09-11): ein eigener
 * OpenAI-kompatibler Server mit einem 256k-Modell. LU zeigte 6.4K, ohne
 * Waehler, und nach dem Umbenennen des Modells auf etwas mit "qwen" im Namen
 * 25.6K. Beide Zahlen sind nachgerechnet: `guessContextFromName` liefert 8192
 * bzw. 32768, davon 0,8 als Sendefenster (8192*0,8 = 6553, 32768*0,8 = 26214)
 * und `formatContextWindow` teilt durch 1024, also "6.4K" und "25.6K". Keine
 * dieser Zahlen hat der Server je gesagt. Aus der geratenen 32768 leitete
 * `applyMaxTokens` dann noch ein `max_tokens` ab, worauf der Server mit "token
 * limit exceeded" antwortete: das Budget war erfunden.
 *
 * Eine Zahl kann nicht sagen, woher sie kommt, also sagt es ein zweites Feld.
 * Dieselbe Lehre steht schon in `agent-num-ctx.ts` ("gemessen" vs. "geraten"),
 * nur dass sie dort an einem Aufrufer haengt statt am Wert selbst.
 *
 * Blattmodul: importiert nichts aus api/*, damit Provider-Schicht und
 * Oberflaeche es gemeinsam benutzen koennen.
 */

/**
 * probe   = der Server hat sein LAUFENDES Fenster gesagt (Katalog oder
 *           Metadaten-Endpunkt)
 * user    = der Nutzer hat es im Waehler gesetzt
 * trained = der Server hat nur die trainierte Decke des Modells genannt
 *           (llama.cpp `n_ctx_train`, LM Studio `max_context_length`). Eine
 *           echte Zahl, aber nicht die des laufenden Servers: er darf kleiner
 *           gestartet sein, und auf der Box war er es (16384 gegen 40960).
 * guess   = aus dem Modellnamen oder einer Tabelle geraten
 */
export type ContextSource = 'probe' | 'user' | 'trained' | 'guess'

export interface ResolvedContextWindow {
  /** Das Fenster in Tokens. */
  tokens: number
  source: ContextSource
  /** Die trainierte Obergrenze, wenn der Server sie genannt hat (0 = unbekannt). */
  modelMax: number
  /**
   * Bei `source: 'guess'`: WORAUS geraten wurde.
   *
   *   'table' = exakte Modell-Id in der gepflegten Liste (gpt-4o, o3,
   *             mixtral-8x7b-32768). Ein veroeffentlichtes, festes Fenster
   *             eines benannten Modells. Kann veralten, ist aber keine
   *             Erfindung.
   *   'name'  = Teilzeichenketten-Heuristik ("enthaelt qwen, also 32768").
   *             GENAU das ist der Ursprung von #129.
   *
   * Der Unterschied entscheidet nur ueber `capIsDerivable`, nicht ueber die
   * Beschriftung: dem Nutzer gegenueber bleiben beide "estimated", weil
   * beide von hier stammen und nicht vom Server.
   */
  guessKind?: 'table' | 'name'
  /**
   * Bei `source: 'user'`: die gespeicherte Wahl, die ueber dem laufenden
   * Fenster lag und deshalb darauf geklemmt wurde (0 oder fehlend = nichts
   * geklemmt).
   *
   * Ein Server, der mit 16384 laeuft, wird nicht groesser, weil jemand im
   * Waehler 40K angeklickt hat. Die Wahl bleibt gespeichert (wer seinen Server
   * groesser neu startet, bekommt sie zurueck), aber gerechnet und angezeigt
   * wird das Fenster, und die Oberflaeche sagt in einer Zeile, warum.
   */
  clampedFrom?: number
}

/**
 * Was im Werkzeugtext neben der Zahl steht. Englisch, wie die ganze
 * Oberflaeche. Jede Zeile muss sich in beide Rahmen fuegen, in denen sie
 * steht: "Context window: X." und "Current value X.".
 */
export const SOURCE_LABEL: Record<ContextSource, string> = {
  probe: 'from server',
  user: 'set by you',
  trained: "from the model's training limit (the server may run smaller)",
  guess: 'estimated',
}

/**
 * Darf aus diesem Fenster ein hartes `max_tokens` abgeleitet werden?
 *
 * Nur wenn die Zahl von jemandem stammt, der sie wissen kann: dem Server oder
 * dem Nutzer. Aus einer Schaetzung ein Budget zu rechnen und das auf die
 * Leitung zu legen ist genau der Fehler aus #129.
 *
 * `trained` zaehlt hier NICHT als bekannt. Die Zahl ist echt, aber sie
 * beschreibt das Modell und nicht den Lauf: ein llama-server mit
 * `--ctx-size 16384` meldet 40960 als trainierte Decke, und ein daraus
 * gerechnetes Budget waere groesser als sein ganzes Fenster. Ohne Budget
 * nimmt der Server seine eigene Voreinstellung, und die kennt er.
 */
export function windowIsKnown(source: ContextSource): boolean {
  return source === 'probe' || source === 'user'
}

/**
 * Darf fuer DIESES Fenster ein `max_tokens` auf die Leitung?
 *
 * Bekannt: ja, das ist die Regel. Dazu die eine Ausnahme, die es vor #129
 * schon gab und die weiter gebraucht wird: die gepflegte Liste benannter
 * Modelle. Sie hat einen eigenen Grund, naemlich Bug 5 vom 2026-07-11
 * (the upstream deckelt sonst selbst fast das ganze Fenster und antwortet auf
 * den echten Prompt mit 400), und sie ist etwas anderes als die
 * Namensheuristik: dort steht eine exakte Id, hier eine Teilzeichenkette.
 * Das Modell des Melders stand in keiner Liste; es hiess nur zufaellig
 * irgendwann "qwen".
 */
export function capIsDerivable(w: Pick<ResolvedContextWindow, 'source' | 'guessKind'>): boolean {
  return windowIsKnown(w.source) || w.guessKind === 'table'
}

/**
 * Darf der Nutzer dieses Fenster verstellen?
 *
 * Lokal immer. Ollama, LM Studio und der LU-Motor bieten den Waehler seit
 * jeher an, obwohl ihr Wert gemessen ist: eine gemessene Zahl ist auf eigener
 * Hardware eine OBERGRENZE, keine Zuteilung von fremder Seite, und wer sein
 * Geraet kennt, darf darunter bleiben (der Melder aus #129 will genau das, sein
 * Agentenlauf ruckelt).
 *
 * Aus der Ferne nie. Dort gehoert das Fenster einer fremden Bereitstellung,
 * LU berichtet es nur, und der bezahlte Sendedeckel ist der Hebel, der den
 * Nenner dort regelt.
 *
 * Die Herkunft der Zahl steht deshalb absichtlich NICHT in der Signatur: sie
 * ist die Begruendung fuer die Antwort, nicht ihre Eingabe. Bis 3.0.0 nahm die
 * Funktion ein `source` entgegen und las es nie (R2-31).
 */
export function windowIsAdjustable(input: { localBackend: boolean }): boolean {
  return input.localBackend
}

export interface ActiveWindowInput {
  /** Was die Kaskade des Providers geliefert hat. */
  resolved: ResolvedContextWindow
  /** Laeuft der Server auf diesem Rechner oder im LAN? */
  localBackend: boolean
}

export interface ActiveWindow {
  contextWindow: number
  modelMax: number
  sendWindow: number
  source: ContextSource
  isTrue: boolean
  adjustable: boolean
  /** Siehe `ResolvedContextWindow.clampedFrom`. 0 = nichts geklemmt. */
  clampedFrom: number
}

/**
 * Das aktive Fenster eines OpenAI-kompatiblen Backends, fertig fuer Zaehler
 * und Waehler.
 *
 * `sendWindow` ist hier gleich dem Fenster: auf einem Server, den der Nutzer
 * selbst betreibt, kostet ein Token kein Geld, also gibt es keinen Grund fuer
 * den bezahlten Sendedeckel. Bis #129 fielen genau diese Backends in den
 * Cloud-Zweig und bekamen ihn trotzdem, was die angezeigte Zahl noch einmal
 * auf 0,8 drueckte.
 */
export function resolveActiveWindow(input: ActiveWindowInput): ActiveWindow {
  const tokens = input.resolved.tokens > 0 ? input.resolved.tokens : 0
  const source = input.resolved.source
  return {
    contextWindow: tokens,
    /*
     * Die Decke der Voreinstellungen im Waehler.
     *
     * Kennt die App das laufende Fenster, ist DAS die Decke: LU kann das `-c`
     * eines fremden Servers nicht setzen, eine groessere Zahl waere also nur
     * eine Behauptung ueber ihn, und aus ihr wuerde wieder ein `max_tokens`
     * ueber seinem Fenster. Erst wenn niemand ein laufendes Fenster genannt
     * hat, darf die Liste bis zur trainierten Decke gehen.
     *
     * Ausnahme bleibt die Wahl des Nutzers OHNE gemessenes Fenster: waere sie
     * selbst die Decke, koennte wer einmal 8K gewaehlt hat nie wieder etwas
     * Groesseres waehlen, denn die Liste endet an dieser Zahl. 0 heisst dort
     * "unbekannt", und unbekannt oeffnet die ganze Liste.
     */
    modelMax: input.resolved.modelMax > 0
      ? input.resolved.modelMax
      : source === 'user' ? 0 : tokens,
    sendWindow: tokens,
    source,
    isTrue: source === 'probe',
    adjustable: windowIsAdjustable({ localBackend: input.localBackend }),
    clampedFrom: input.resolved.clampedFrom ?? 0,
  }
}

/**
 * Der Schluessel, unter dem die Wahl des Nutzers liegt: Endpunkt UND Modell.
 *
 * Dieselbe Form wie `catalogKey` im OpenAI-Provider. Der Endpunkt muss mit
 * hinein, weil zwei Server dasselbe Modell unterschiedlich gross laden.
 */
export function contextWindowKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, '')}|${model}`
}

/** Die gespeicherte Wahl fuer diesen Schluessel, 0 = keine. */
export function storedWindow(map: Record<string, number> | undefined, key: string): number {
  const v = map?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * Die Karte nach einer Wahl. 0 bedeutet "Auto", und Auto ist ein Loeschen und
 * kein gespeicherter Nullwert: sonst wuechse die Karte mit jedem Modell, das
 * jemand einmal angesehen hat.
 */
export function withStoredWindow(
  map: Record<string, number> | undefined,
  key: string,
  tokens: number,
): Record<string, number> {
  const next = { ...(map ?? {}) }
  if (tokens > 0) next[key] = Math.floor(tokens)
  else delete next[key]
  return next
}
