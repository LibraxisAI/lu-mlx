import { describe, it, expect } from 'vitest'
import { menuPositionUnderZoom } from '../ContextMenu'

// Die App-Wurzel liegt unter zoom 1.15. `left`/`top` zaehlen in den Pixeln der
// Wurzel, der Zeiger in sichtbaren Pixeln. Sichtbar ist left * zoom.
const ZOOM = 1.15
const VIEW = { width: 1280, height: 800 }

describe('das Rechtsklick-Menue sitzt am Zeiger, auch unter dem Zoom', () => {
  it('Chromium und neues WebKit (Kasten in sichtbaren Pixeln): die linke obere Ecke liegt sichtbar am Zeiger', () => {
    const p = menuPositionUnderZoom(400, 300, { width: 176 * ZOOM, height: 120 * ZOOM }, VIEW, ZOOM, ZOOM)
    expect(p.left * ZOOM).toBeCloseTo(400, 5)
    expect(p.top * ZOOM).toBeCloseTo(300, 5)
  })

  it('aelteres WebKitGTK (Kasten in den Pixeln der Wurzel): dieselbe Stelle', () => {
    const p = menuPositionUnderZoom(400, 300, { width: 176, height: 120 }, VIEW, ZOOM, 1)
    expect(p.left * ZOOM).toBeCloseTo(400, 5)
    expect(p.top * ZOOM).toBeCloseTo(300, 5)
  })

  it('am rechten unteren Rand bleibt das ganze Menue sichtbar im Fenster', () => {
    for (const verhaeltnis of [ZOOM, 1]) {
      const f = verhaeltnis === ZOOM ? ZOOM : 1
      const p = menuPositionUnderZoom(1270, 790, { width: 176 * f, height: 120 * f }, VIEW, ZOOM, verhaeltnis)
      expect((p.left + 176) * ZOOM).toBeLessThanOrEqual(VIEW.width)
      expect((p.top + 120) * ZOOM).toBeLessThanOrEqual(VIEW.height)
      expect(p.left).toBeGreaterThanOrEqual(0)
      expect(p.top).toBeGreaterThanOrEqual(0)
    }
  })

  it('ohne Zoom aendert sich nichts', () => {
    expect(menuPositionUnderZoom(400, 300, { width: 176, height: 120 }, VIEW, 1, 1)).toEqual({ left: 400, top: 300 })
  })
})
