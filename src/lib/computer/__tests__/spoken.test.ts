import { describe, expect, it } from 'vitest'
import { spokenAnswer, spokenQuestion } from '../spoken'
import type { ComputerApp } from '../../../api/computer'
import type { ComputerPrompt } from '../../../stores/computerStore'

const NOTEPAD = { key: 'notepad.exe', name: 'Notepad.exe' } as ComputerApp

function prompt(over: { kind?: 'app'; description?: string; sensitive?: boolean; app?: ComputerApp } = {}): ComputerPrompt {
  const app = over.app ?? NOTEPAD
  if (over.kind === 'app') return { kind: 'app', id: 'p1', app, windowTitle: null }
  return { kind: 'confirm', id: 'p1', app, description: over.description ?? 'Click at 662, 511', reason: null, sensitive: over.sensitive ?? false }
}

describe('spokenQuestion', () => {
  it('asks for an app in one short sentence that a yes can answer', () => {
    const q = spokenQuestion(prompt({ kind: 'app' }))
    expect(q).toEqual({ text: 'May I work in Notepad? Say yes or no.', voice: true })
  })

  it('names the kind of action, not the coordinates and not the typed text', () => {
    expect(spokenQuestion(prompt()).text).toBe('I want to click in Notepad. Yes or no?')
    const typed = spokenQuestion(prompt({ description: 'Type "my secret diary entry"' }))
    expect(typed.text).toBe('I want to type some text in Notepad. Yes or no?')
    expect(typed.text).not.toContain('secret')
  })

  it('sends a sensitive action to the click', () => {
    const q = spokenQuestion(prompt({ sensitive: true }))
    expect(q.voice).toBe(false)
    expect(q.text).toContain('needs your click')
  })

  it('does not speak odd characters of an app name', () => {
    expect(spokenQuestion(prompt({ kind: 'app', app: { key: 'x', name: 'Evil<script>"App"' } as ComputerApp })).text)
      .toBe('May I work in Evil script App? Say yes or no.')
  })
})

describe('spokenAnswer', () => {
  it('lets a spoken yes allow an app for the session only', () => {
    expect(spokenAnswer(prompt({ kind: 'app' }), 'yes')).toBe('session')
    expect(spokenAnswer(prompt({ kind: 'app' }), 'no')).toBe('deny')
  })

  it('lets a spoken yes run an ordinary action', () => {
    expect(spokenAnswer(prompt(), 'yes')).toBe(true)
    expect(spokenAnswer(prompt(), 'no')).toBe(false)
  })

  it('does not accept a spoken yes for a sensitive action, and always accepts a no', () => {
    const sensitive = prompt({ sensitive: true })
    expect(spokenAnswer(sensitive, 'yes')).toBeNull()
    expect(spokenAnswer(sensitive, 'no')).toBe(false)
  })
})

describe('a permission of the operating system', () => {
  const missing: ComputerPrompt = { kind: 'permission', id: 'p9', permission: 'accessibility' }

  it('is announced, and sent to the screen: no spoken yes can grant it', () => {
    const q = spokenQuestion(missing)
    expect(q.voice).toBe(false)
    expect(q.text).toBe('Your Mac has to allow this first. Please look at the screen: I need the Accessibility permission.')
    expect(spokenQuestion({ kind: 'permission', id: 'p9', permission: 'screen_recording' }).text).toContain('Screen Recording')
    expect(spokenAnswer(missing, 'yes')).toBeNull()
  })

  it('a spoken no closes it', () => {
    expect(spokenAnswer(missing, 'no')).toBe(false)
  })
})
