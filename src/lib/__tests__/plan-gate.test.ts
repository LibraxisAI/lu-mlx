/**
 * Planning is opt-in (customer case 30.09.2026, see lib/plan-gate.ts).
 *
 * Run: npx vitest run src/lib/__tests__/plan-gate.test.ts
 */
import { describe, it, expect } from 'vitest'
import { gatePlanTool, planToolAllowed, userAskedForPlan, PLAN_TOOL } from '../plan-gate'
import type { TodoItem } from '../../stores/todoStore'

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

describe('userAskedForPlan', () => {
  it.each([
    'Make a plan for the login refactor',
    'write me a step-by-step plan',
    'give me a todo list and then do it',
    'plan this before you touch anything',
    'go step by step please',
    'Mach mir einen Plan für die Migration',
    'erst einen Plan, dann umsetzen',
    'schritt für schritt bitte',
    'erstelle eine Todo-Liste',
  ])('hears a plan request in %j', (text) => {
    expect(userAskedForPlan(text)).toBe(true)
  })

  it.each([
    'fix the build steps in ci.yml',
    'add a plan field to the pricing form',
    'the pricing plan page is broken',
    'build me a todo app in React',
    'Baue mir eine Landingpage',
    'refactor src/app.ts and run the tests',
  ])('stays quiet on %j', (text) => {
    expect(userAskedForPlan(text)).toBe(false)
  })
})

describe('planToolAllowed', () => {
  it('is off for an ordinary coding task', () => {
    expect(planToolAllowed({ mode: 'ask', userText: 'build me a todo app', todos: [] })).toBe(false)
  })

  it('is on in Plan mode', () => {
    expect(planToolAllowed({ mode: 'plan', userText: 'look at the auth code', todos: [] })).toBe(true)
  })

  it('is on when the user asked for a plan', () => {
    expect(planToolAllowed({ mode: 'bypass', userText: 'make a plan first', todos: [] })).toBe(true)
  })

  it('stays on while an open plan has to be kept current', () => {
    const todos = [t('read', 'completed'), t('edit', 'in_progress')]
    expect(planToolAllowed({ mode: 'ask', userText: 'continue', todos })).toBe(true)
  })

  it('goes off again once the plan is finished', () => {
    const todos = [t('read', 'completed'), t('edit', 'completed')]
    expect(planToolAllowed({ mode: 'ask', userText: 'continue', todos })).toBe(false)
  })
})

describe('gatePlanTool', () => {
  const defs = [{ name: 'file_read' }, { name: PLAN_TOOL }, { name: 'shell_execute' }]

  it('removes todo_write when planning is not allowed', () => {
    expect(gatePlanTool(defs, false).map((d) => d.name)).toEqual(['file_read', 'shell_execute'])
  })

  it('keeps the catalog untouched when it is', () => {
    expect(gatePlanTool(defs, true)).toBe(defs)
  })
})
