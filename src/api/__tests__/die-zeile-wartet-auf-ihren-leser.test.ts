/**
 * @vitest-environment jsdom
 *
 * Eine Zeile darf nicht ablaufen, solange sie nirgends als SATZ zu sehen ist.
 *
 * Beide Ansagen ueber eine Wahl, die sich von selbst geaendert hat, werden von
 * den Einstellungen aus ausgeloest. Der gemessene Fall G1 (04.09.2026) ist
 * "Provider LM Studio wieder herausgenommen", der zweite ist "Enable auf der
 * Standby-Karte". Gezeichnet wird die Zeile aber von `LuEngineSwitchBar`, und
 * die haengt ueber dem Eingabefeld im Chat und auf der Models-Seite, nicht im
 * Einstellungsblatt. Auf der gewoehnlichen Zwoelf-Sekunden-Uhr lief sie also
 * genau dort ab, wo niemand sie sehen konnte, und der Kunde kam in einen Chat
 * zurueck, in dem ein anderes Modell stand und kein Wort dazu. Das war der
 * Befund, und die Zeile allein hat ihn nicht behoben.
 *
 * ── 21.09.2026: derselbe Fehler eine Nummer kleiner ──
 *
 * Die Zeile haengt im Chat seither nicht mehr ueber dem Eingabefeld, sondern
 * im Modellmenue; ohne Klick ist dort nur der Punkt am Waehlerknopf zu sehen.
 * Damit stimmte „im Chat zu sein" nicht mehr als Beleg fuer „gelesen": eine
 * Info lief ihre zwoelf Sekunden ab, waehrend vom Text kein Wort auf dem
 * Schirm war, und der Punkt ging mit ihr. Gemeldet aus dem echten Bau
 * e6db0e88. Der Eigner will Hinweise „unauffaellig, aber so, dass man sie
 * sieht"; das war unauffaellig und unsichtbar.
 *
 * Gelesen heisst deshalb jetzt: die Models-Seite zeigt die volle Leiste von
 * selbst, ODER jemand hat das Modellmenue mit dieser Zeile aufgeklappt
 * (`dieZeileIstZuSehen` in lib/engine-offload.ts). Die Obergrenze gegen ewige
 * Punkte ist unveraendert `UNSEEN_NOTE_HOLD_MS`.
 *
 * Run: npx vitest run src/api/__tests__/die-zeile-wartet-auf-ihren-leser.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../backend', () => ({
  backendCall: vi.fn(async () => ({})),
  isTauri: () => false,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const {
  announceChatModelReplaced, announceChatModelLostItsEngine, UNSEEN_NOTE_HOLD_MS,
} = await import('../lu-engine-switch')
const { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS, HOLD_CHECK_MS } =
  await import('../../stores/luEngineSwitchStore')
const { useUIStore } = await import('../../stores/uiStore')

/** Was der Modellwaehler tut, sobald er mit dieser Zeile aufklappt. */
const menueAufklappen = () => useLuEngineSwitchStore.getState().alsGesehenMarkieren()

const WEG = 'openai::Qwen3-4B-Q4_K_M'
const STATT = 'openai::G1-Kaputt-Q4_K_M'

const zeile = () => useLuEngineSwitchStore.getState().note
const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

beforeEach(() => {
  vi.useFakeTimers()
  useLuEngineSwitchStore.getState().dismiss()
  useUIStore.setState({ currentView: 'settings' })
})
afterEach(() => {
  useLuEngineSwitchStore.getState().dismiss()
  useUIStore.setState({ currentView: 'chat' })
  vi.useRealTimers()
})

describe('die Zeile ueber die selbst getauschte Wahl', () => {
  it('steht noch, wenn der Nutzer nach 12,44 s immer noch in den Einstellungen ist', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(12_440)
    expect(zeile()).not.toBeNull()
  })

  it('und laeuft erst ab, nachdem das Modellmenue sie gezeigt hat', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(30_000)
    expect(zeile()).not.toBeNull()

    // Im Chat zu stehen genuegt NICHT mehr: dort ist ohne Klick nur der Punkt
    // zu sehen. Das ist der Befund aus dem Bau e6db0e88.
    useUIStore.setState({ currentView: 'chat' })
    vi.advanceTimersByTime(HOLD_CHECK_MS + 3 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile(), 'ein Punkt ist kein Leser').not.toBeNull()

    // Jetzt klappt der Waehler auf. Der Halt wird im Sekundentakt geprueft,
    // danach beginnt die Lesezeit bei null.
    menueAufklappen()
    vi.advanceTimersByTime(HOLD_CHECK_MS + LU_ENGINE_SWITCH_NOTE_MS - 1_000)
    expect(zeile()).not.toBeNull()
    vi.advanceTimersByTime(2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('die Models-Seite zaehlt auch, die Zeile haengt dort ebenfalls', () => {
    useUIStore.setState({ currentView: 'models' })
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile(), 'auf einer Seite, die sie zeigt, gilt die gewoehnliche Uhr').toBeNull()
  })

  it('bleibt nicht ewig stehen, wenn er nie zurueckkommt', () => {
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(UNSEEN_NOTE_HOLD_MS + 3 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('im Chat steht sie beliebig lange, solange das Menue nie offen war', () => {
    // Der gemeldete Fall aus dem Bau e6db0e88, als Zusicherung. Vorher war die
    // Zeile nach 12 s weg und mit ihr der Punkt, und gelesen hatte sie
    // niemand.
    useUIStore.setState({ currentView: 'chat' })
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(10 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile(), 'die Zeile ist verfallen, ohne je lesbar gewesen zu sein').not.toBeNull()
  })

  it('aber nicht ewig: die Obergrenze gilt auch im Chat', () => {
    // Die einzige Obergrenze, und es ist die, die es schon gab. Ohne sie waere
    // ein nie angeklickter Punkt ein Punkt bis zum Ende der Sitzung.
    useUIStore.setState({ currentView: 'chat' })
    announceChatModelReplaced(WEG, STATT)
    vi.advanceTimersByTime(UNSEEN_NOTE_HOLD_MS + 3 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('und die naechste Ansage ersetzt die vorige samt ihrem Gelesen-Stand', () => {
    // Der zweite Teil der Obergrenze, und er kostet nichts: er gilt ohnehin.
    // Der dritte ist der Neustart, denn dieser Speicher wird nicht
    // persistiert (siehe das Ende von api/lu-engine-switch.ts).
    useUIStore.setState({ currentView: 'chat' })
    announceChatModelReplaced(WEG, STATT)
    menueAufklappen()
    expect(useLuEngineSwitchStore.getState().gesehen).toBe(true)
    announceChatModelReplaced(STATT, WEG)
    expect(useLuEngineSwitchStore.getState().gesehen, 'ein neuer Satz ist ungelesen').toBe(false)
    expect(zeile()).toContain('G1-Kaputt-Q4_K_M')
  })

  it('eine FEHLER-Zeile ist unveraendert ohne Uhr', () => {
    // Die steht, bis jemand sie wegdrueckt oder die naechste sie ersetzt, und
    // daran aendert der Gelesen-Stand nichts: sie verlangt eine Handlung.
    useUIStore.setState({ currentView: 'chat' })
    useLuEngineSwitchStore.getState().announce('The LU Engine could not start.', 'error')
    vi.advanceTimersByTime(20 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBe('The LU Engine could not start.')
    menueAufklappen()
    vi.advanceTimersByTime(20 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile(), 'auch gelesen laeuft ein Fehler nicht ab').toBe('The LU Engine could not start.')
  })

  it('das x nimmt Zeile und Gelesen-Stand zusammen', () => {
    useUIStore.setState({ currentView: 'chat' })
    announceChatModelReplaced(WEG, STATT)
    menueAufklappen()
    useLuEngineSwitchStore.getState().dismiss()
    expect(zeile()).toBeNull()
    expect(useLuEngineSwitchStore.getState().gesehen).toBe(false)
  })

  // Negativkontrolle: genau die alte Ansage, an genau diesem Ablauf.
  it('die alte Ansage ohne Halt waere in den Einstellungen verfallen', () => {
    useLuEngineSwitchStore.getState().announce('irgendein Satz ohne Halt', 'info')
    vi.advanceTimersByTime(12_440)
    expect(zeile()).toBeNull()
  })
})

describe('die Zeile ueber die mit dem Steckplatz gefallene Wahl', () => {
  it('wartet genauso, sie wird sogar in den Einstellungen ausgeloest', () => {
    announceChatModelLostItsEngine(WEG, 'LM Studio')
    vi.advanceTimersByTime(12_440)
    expect(zeile()).not.toBeNull()
    useUIStore.setState({ currentView: 'chat' })
    menueAufklappen()
    vi.advanceTimersByTime(HOLD_CHECK_MS + 2 * LU_ENGINE_SWITCH_NOTE_MS)
    expect(zeile()).toBeNull()
  })

  it('ohne Namen des Uebernehmers bleibt der Satz trotzdem ein Satz', () => {
    announceChatModelLostItsEngine(WEG, null)
    expect(zeile()).toContain('another backend')
    expect(zeile()).toContain('Qwen3-4B-Q4_K_M')
  })
})

describe('warum genau diese beiden Seiten', () => {
  it('die Zeile haengt im Chat und auf der Models-Seite', () => {
    // Im Chat seit dem 21.09.2026 NICHT mehr ueber dem Eingabefeld, sondern
    // im Modellwaehler, der dort im Composer steht (der Inhaber: „NICHTS im prompt
    // fenster!"). Der Satz handelt vom Modell, also steht er, wo man das
    // Modell waehlt; erreichbar bleibt er ueber den Punkt am Waehlerknopf,
    // der auch dann stehen bleibt, wenn das Menue zufaellt.
    expect(lies('components/models/ModelSelector.tsx')).toContain('picker-engine-note')
    expect(lies('components/chat/ChatView.tsx')).toContain('<ModelSelector')
    const models = lies('components/models/ModelManager.tsx') + lies('components/models/DiscoverModels.tsx')
    expect(models).toContain('<LuEngineSwitchBar />')
  })

  it('und nicht im Einstellungsblatt, wo beide Ausloeser sitzen', () => {
    const settings = lies('components/settings/SettingsPage.tsx') + lies('components/settings/ProviderConfig.tsx')
    expect(settings).not.toContain('LuEngineSwitchBar')
    // Beide Ausloeser stehen wirklich dort: Remove auf der Provider-Karte und
    // Enable auf der Standby-Karte.
    expect(lies('components/settings/ProviderConfig.tsx')).toContain('slotHandbackUpdate')
  })
})
