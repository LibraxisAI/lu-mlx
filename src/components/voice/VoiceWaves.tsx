import { useEffect, useRef } from 'react'
import { voiceLevels } from '../../api/voice-session'

/** What the waves express. It sets their colour and what moves them. */
export type VoiceMood = 'idle' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'muted'

interface Props {
  mood: VoiceMood
  className?: string
}

type Rgb = readonly [number, number, number]

// The signal colours the app already uses (blue, purple, emerald), at the
// 400 step on the dark surface and the 600 step on the light one.
const DARK: Record<VoiceMood, Rgb> = {
  idle: [212, 212, 216],
  starting: [212, 212, 216],
  listening: [96, 165, 250],
  thinking: [192, 132, 252],
  speaking: [52, 211, 153],
  waiting: [229, 229, 229],
  muted: [115, 115, 115],
}
const LIGHT: Record<VoiceMood, Rgb> = {
  idle: [107, 114, 128],
  starting: [107, 114, 128],
  listening: [37, 99, 235],
  thinking: [147, 51, 234],
  speaking: [5, 150, 105],
  waiting: [75, 85, 99],
  muted: [156, 163, 175],
}

const BANDS = 10

// How far the bands stand open without any sound, in parts of the height.
// Never zero while a session can hear: a flat line reads as switched off.
const REST: Record<VoiceMood, number> = {
  idle: 0.12,
  starting: 0.09,
  listening: 0.14,
  thinking: 0.1,
  speaking: 0.12,
  waiting: 0.1,
  muted: 0.02,
}
const mix = (a: Rgb, b: Rgb, f: number): Rgb => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
const rgba = (c: Rgb, alpha: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.min(1, alpha).toFixed(3)})`

/**
 * The living part of the Voice surface: ten thin bands, mirrored around a
 * centre line, that open like a mouth with the loudness of whoever is
 * talking. The level comes straight from the audio graph, and the canvas is
 * drawn outside React, so there is no render per frame.
 */
export function VoiceWaves({ mood, className = '' }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const moodRef = useRef(mood)

  useEffect(() => {
    moodRef.current = mood
  }, [mood])

  useEffect(() => {
    const node = canvas.current
    // No layout, no canvas: a test environment has nothing to draw on.
    if (!node || typeof ResizeObserver === 'undefined') return
    const ctx = node.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    const measure = () => {
      const ratio = window.devicePixelRatio || 1
      width = node.clientWidth
      height = node.clientHeight
      node.width = Math.max(1, Math.round(width * ratio))
      node.height = Math.max(1, Math.round(height * ratio))
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    let frame = 0
    let shown = 0
    let rest = REST[moodRef.current]
    let colour: Rgb | null = null

    const draw = (ms: number) => {
      const now = moodRef.current
      const dark = document.documentElement.classList.contains('dark')
      const target = (dark ? DARK : LIGHT)[now]
      colour = colour ? mix(colour, target, still ? 1 : 0.07) : target

      const levels = voiceLevels()
      const raw = now === 'speaking' ? levels.bot : now === 'listening' ? levels.mic : 0
      // Speech sits far below full scale. The root spreads it over the bands.
      const level = still ? (now === 'speaking' || now === 'listening' ? 0.3 : 0) : Math.min(1, Math.sqrt(raw) * 1.8)
      // Rise fast, fall slowly: speech looks like speech and not like flicker.
      shown = level > shown ? shown + (level - shown) * 0.5 : shown * 0.93

      const t = still ? 0 : ms / 1000
      const breath = now === 'muted' ? 0 : 0.5 + 0.5 * Math.sin(t * 1.3)
      const travelling = !still && (now === 'thinking' || now === 'starting')
      rest += (REST[now] - rest) * (still ? 1 : 0.07)
      const unit = height / 200
      const span = Math.min(width - 24, 460)

      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.translate(width / 2, height / 2)
      ctx.lineCap = 'round'
      // Light adds up on the dark surface. On the light one it would vanish.
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'
      ctx.shadowColor = rgba(colour, dark ? 0.9 : 0.35)
      ctx.shadowBlur = (dark ? 5 + shown * 14 : 2 + shown * 4) * Math.max(0.5, unit)

      for (let band = 0; band < BANDS; band++) {
        const pair = Math.floor(band / 2)
        const side = band % 2 ? 1 : -1
        const lead = pair === 0
        // A low band keeps a resting shape one can see, so it scales less.
        const reach = rest * (100 + pair * 22) * Math.max(unit, 0.7) + (5 * breath + shown * (70 - pair * 9)) * unit
        const alpha = (dark ? 0.2 : 0.34) + 0.56 * shown + (lead ? 0.22 : 0) + (travelling ? 0.14 : 0) - pair * 0.03
        // The bands fade out towards both ends instead of meeting in a bar.
        const tint = dark && lead ? mix(colour, [255, 255, 255], 0.55) : colour
        const stroke = ctx.createLinearGradient(-span / 2, 0, span / 2, 0)
        stroke.addColorStop(0, rgba(tint, 0))
        stroke.addColorStop(0.22, rgba(tint, alpha))
        stroke.addColorStop(0.78, rgba(tint, alpha))
        stroke.addColorStop(1, rgba(tint, 0))
        ctx.strokeStyle = stroke
        ctx.lineWidth = lead ? 1.5 : 1
        ctx.beginPath()
        for (let x = -span / 2; x <= span / 2; x += 3) {
          const u = x / span + 0.5
          const envelope = Math.sin(Math.PI * u) ** 2
          let y = side * reach * envelope * (0.45 + 0.55 * Math.sin(u * (9 + pair * 2) + t * (2 + pair * 0.4) + pair))
          // Thinking and starting: one bump that keeps running through.
          if (travelling) y += side * 26 * unit * envelope * Math.exp(-(((u - ((t * 0.45 + pair * 0.03) % 1)) * 7) ** 2))
          if (x === -span / 2) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.restore()
      // Reduced motion gets the right colour and shape, redrawn calmly.
      frame = still ? window.setTimeout(() => draw(0), 250) : requestAnimationFrame(draw)
    }
    draw(performance.now())

    return () => {
      observer.disconnect()
      if (still) window.clearTimeout(frame)
      else cancelAnimationFrame(frame)
    }
  }, [])

  return <canvas ref={canvas} aria-hidden="true" data-testid="voice-waves" data-mood={mood} className={`block w-full ${className}`} />
}
