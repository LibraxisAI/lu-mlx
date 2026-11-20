// @vitest-environment jsdom
/**
 * The box, 03.10.2026: the Expert section of the advanced settings was folded
 * shut again every time the panel was opened, so the LoRA stack was two
 * clicks away each time. Whether it is open is remembered while the app runs
 * (not across a restart: a fresh start shows the short panel).
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCreateStore } from '../../../../stores/createStore'
import { ParamGroups } from '../ParamGroups'

vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: ['euler'], schedulerList: ['simple'], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useCreateStore.setState({ backend: 'local', expertOpen: false } as never)
  useCreateStore.getState().setIntent('image')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the Expert section of the advanced settings', () => {
  it('starts folded', () => {
    render(createElement(ParamGroups))
    expect(screen.queryByText('Sampler')).toBeNull()
  })

  it('is still open when the panel is closed and opened again', () => {
    const first = render(createElement(ParamGroups))
    fireEvent.click(screen.getByText('Expert'))
    expect(screen.getByText('Sampler')).toBeTruthy()
    first.unmount()
    render(createElement(ParamGroups))
    expect(screen.getByText('Sampler')).toBeTruthy()
  })

  it('folds again when the user folds it, and stays folded', () => {
    const first = render(createElement(ParamGroups))
    fireEvent.click(screen.getByText('Expert'))
    fireEvent.click(screen.getByText('Expert'))
    first.unmount()
    render(createElement(ParamGroups))
    expect(screen.queryByText('Sampler')).toBeNull()
  })

  it('is not written to disk', () => {
    useCreateStore.getState().setExpertOpen(true)
    const saved = JSON.parse(localStorage.getItem(useCreateStore.persist.getOptions().name ?? '') ?? '{}')
    expect(saved.state?.expertOpen).toBeUndefined()
  })
})
