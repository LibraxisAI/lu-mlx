/**
 * Welche Maschine der Assistent nachher anspricht — der geteilte Kern des
 * ganzen Assistenten.
 *
 * Warum es dieses Modul gibt: das Ergebnis des Port-Scans ist der einzige
 * Zustand, den FUENF der sechs Bildschirme anfassen, und zwei von ihnen
 * schreiben ihn:
 *
 *   Willkommen    startet den Scan beim Weiterklicken
 *   Backends      zeichnet ihn, laesst waehlen, scannt neu
 *   Modelle       entscheidet daran, WOHIN eine GGUF geschrieben wird
 *                 (Ollama-Pull, App-Ordner, LM-Studio-Verschachtelung)
 *   Einbettungen  entscheidet daran, welcher Embeddings-Weg genommen wird
 *   Fertig        nennt den verbundenen Backend beim Namen
 *
 * Genau deshalb steht er NICHT im Backend-Schritt, obwohl er dort gezeichnet
 * wird: ein Schritt, der den Zustand von vier anderen haelt, ist kein Schritt,
 * sondern die Schale mit einer Tarnkappe. Er steht hier, oberhalb der
 * Schritte, und wird ihnen gereicht.
 *
 * Was der Schritt dagegen SELBST behaelt: `detecting` faerbt nur seinen
 * eigenen Bildschirm — es steht trotzdem hier, weil `runDetection` es setzt
 * und die Funktion von zwei Bildschirmen gerufen wird. Ein Flag, das eine
 * Funktion setzt, gehoert zu der Funktion.
 */
import { useState } from 'react'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { BUILTIN_BACKEND_ID } from '../../lib/onboarding-backend'
import { backendCall } from '../../api/backend'
import { isTauri } from './onboarding-host'
import type { LmStudioServerStatus } from '../models/ModelSelector'

/**
 * Der Deckel ueber dem GANZEN Scan, nicht ueber einer einzelnen Sonde.
 *
 * T2 hat auf der Box gemessen, was ohne ihn passiert: nach `Re-run onboarding`
 * stand `Scanning for local backends...` ueber vier Minuten, ohne Knopf, ohne
 * neue Logzeile, und erst ein Neustart der App loeste es.
 *
 * Jede einzelne Sonde IST gedeckelt (`lib/backend-detector.ts`: 2000 ms
 * Anfrage, 2500 ms Rennen darueber), und sie laufen parallel, nach 2,5
 * Sekunden ist der Klopfteil also in jedem Fall vorbei. Der Scan endet dort
 * aber nicht: findet er nichts, fragt er danach `lmstudio_server_status`, und
 * dieser Aufruf geht OHNE Frist nach Rust. Antwortet Rust nicht, bleibt
 * `detecting` fuer immer wahr, und in diesem Zustand zeichnet der Schritt
 * keinen einzigen Knopf.
 *
 * 6000 ms ist gerechnet und nicht geraten: 2500 ms fuer die Sonden, die
 * restlichen 3500 ms fuer die eine Nachfrage. Wer darueber hinaus laeuft,
 * haelt den Assistenten nicht mehr auf; der Schritt zeigt dann, was bis dahin
 * da ist, und der Weg weiter steht offen.
 */
export const SCAN_DEADLINE_MS = 6000

export interface BackendScan {
  detectedBackends: DetectedBackend[]
  detecting: boolean
  selectedBackend: string
  setSelectedBackend: (id: string) => void
  /** LM Studio liegt auf der Platte, sein Server hoert aber nicht zu. */
  lmstudioOfflineDetected: boolean
  /** GGUFs in `~/.lmstudio/models/`, als Vertrauenshinweis in der Karte. */
  lmstudioModelCount: number
  runDetection: () => Promise<void>
  /** Nicht laenger warten und mit dem weitermachen, was bis hierhin da ist. */
  stopDetection: () => void
}

export function useBackendScan(): BackendScan {
  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [detecting, setDetecting] = useState(false)
  // 2.5.7: the built-in engine is the pre-selected default — a fresh install
  // needs nothing installed. Detected Ollama/LM Studio are offered as Advanced.
  const [selectedBackend, setSelectedBackend] = useState<string>(BUILTIN_BACKEND_ID)
  // Set when LM Studio is installed on the box but its embedded server is
  // not currently listening on :1234. Surfaces a "Start LM Studio server"
  // primary action instead of pushing the user through a redundant 570 MB
  // re-install. The install_lmstudio Tauri command is idempotent — it
  // detects the existing install and skips straight to bootstrap+server
  // start — so we route through the same code path either way; only the
  // UI labelling differs.
  const [lmstudioOfflineDetected, setLmstudioOfflineDetected] = useState(false)
  // Soft-detect: GGUFs in ~/.lmstudio/models/ even when we can't locate
  // lms.exe. Set when a user-style users have LM Studio installed
  // system-wide (C:\Program Files\LM Studio) and the Rust path scan misses
  // it, but the canonical models dir is populated anyway. We surface a
  // "Start LM Studio server" CTA either way — the model count gives a
  // confidence cue in the offline-detected card.
  const [lmstudioModelCount, setLmstudioModelCount] = useState(0)

  /* ── Scan for backends ──────────────────────────────────── */

  /** Der Scan selbst. Wie lange der Bildschirm auf ihn wartet, sagt er nicht. */
  const detect = async () => {
    const backends = await detectLocalBackends()
    setDetectedBackends(backends)
    // Was der Scan findet, waehlt er NICHT aus. Die eingebaute Maschine steht
    // ab Werk im Waehler, und ein zweiter Zweig fuer "noch nichts gewaehlt" war
    // von Anfang an unerreichbar: der Anfangswert ist ein nicht leerer String,
    // die Frage "noch nichts gewaehlt" also nie wahr (R2-52). Gewaehlt wird in
    // BackendsStep, von Hand, an vier Stellen.
    if (backends.length === 0 && isTauri) {
      // No live backend on any well-known port. Before we push the user
      // through a 570 MB LM-Studio re-install, ask the Rust side whether
      // LM Studio is actually present on disk — its embedded server may
      // just be turned off. lmstudio_server_status is cheap (a single
      // reqwest probe + a path check) and was added in the same sweep
      // that introduced this branch.
      //
      // v2.4.4 (Bug #2): the status payload now also includes
      // `models_detected` / `model_count` — set by scanning
      // ~/.lmstudio/models/ for GGUF files. We treat that as a strong
      // soft-detect signal: if the user has models in the canonical dir,
      // they obviously *have* LM Studio, regardless of whether our path
      // scan turned up lms.exe (a user's system-wide install reproed this).
      try {
        const status = await backendCall<LmStudioServerStatus>('lmstudio_server_status')
        const offline = status?.lms_present && !status?.running
        const softDetect = status?.models_detected && !status?.running
        if (offline || softDetect) {
          setLmstudioOfflineDetected(true)
          setLmstudioModelCount(Number(status?.model_count) || 0)
        }
      } catch { /* command unavailable, ignore */ }
    }
  }

  /**
   * Der Scan, wie der Bildschirm ihn erlebt: mit Deckel.
   *
   * Der Scan laeuft weiter, wenn der Deckel ihn ueberholt, und was er danach
   * noch findet, schreibt er nach. Nur WARTEN muss der Bildschirm nicht mehr
   * darauf. Deshalb ein eigenes Versprechen statt eines `await`, und deshalb
   * faengt es seinen eigenen Fehler ab: "nichts erreichbar" ist im Assistenten
   * kein Fehler, den jemand zu lesen bekommt.
   */
  const runDetection = async () => {
    setDetecting(true)
    setLmstudioOfflineDetected(false)
    setLmstudioModelCount(0)
    const scan = detect().catch(() => { /* nothing reachable, the screen says so */ })
    const deadline = new Promise<void>((resolve) => { setTimeout(resolve, SCAN_DEADLINE_MS) })
    await Promise.race([scan, deadline])
    setDetecting(false)
  }

  /** Nicht laenger warten: der Bildschirm zeigt, was bis hierhin da ist. */
  const stopDetection = () => setDetecting(false)

  return {
    detectedBackends,
    detecting,
    selectedBackend,
    setSelectedBackend,
    lmstudioOfflineDetected,
    lmstudioModelCount,
    runDetection,
    stopDetection,
  }
}
