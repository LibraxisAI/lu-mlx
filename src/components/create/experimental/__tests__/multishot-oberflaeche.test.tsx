// @vitest-environment jsdom
/**
 * Multishot mit LTX 2.5 (02.10.2026): die Shot-Liste in den erweiterten
 * Einstellungen, nur lokal und nur wenn ein LTX-2.5-Modell gewaehlt ist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const host = vi.hoisted(() => ({ mlx: false }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => host.mlx }))
vi.mock('../../../../api/comfyui', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  classifyModel: (n: string) => (/ltx[._-]?2[._-]?5/i.test(n) ? 'ltx25' : /wan/i.test(n) ? 'wan22' : 'sdxl'),
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { Composer } from '../Composer'
import { useCreateStore } from '../../../../stores/createStore'

const LTX = 'ltx-2.5-22b-distilled.safetensors'
const WAN = 'wan2.2_t2v_14b.safetensors'

function setup(model: string, type: string, intent: 'video' | 'animate' = 'video') {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, videoShots: [],
    videoModel: model, videoModelList: [{ name: model, type }], cloudOp: null, utilityOp: null, removebg: false,
  } as never)
  useCreateStore.getState().setMode('video')
  useCreateStore.getState().setIntent(intent)
}

beforeEach(() => { host.mlx = false })
afterEach(() => { cleanup() })

describe('Shot-Liste', () => {
  it('steht bei lokalem Text-zu-Video mit LTX 2.5, standardmaessig mit einem Shot', () => {
    setup(LTX, 'ltx25')
    render(<ParamGroups />)
    expect(screen.getByText('Shots')).toBeTruthy()
    expect(screen.queryByLabelText(/Shot 2/)).toBeNull()
    expect(screen.getByText(/Add more to cut between shots/i)).toBeTruthy()
  })

  it('mehr Shots geben je ein Feld, Shot 1 ist der Prompt', () => {
    setup(LTX, 'ltx25')
    const { container } = render(<ParamGroups />)
    const range = [...container.querySelectorAll('input[type=range]')].find((el) => (el as HTMLInputElement).max === '4') as HTMLInputElement
    expect(range.min).toBe('1')
    fireEvent.change(range, { target: { value: '3' } })
    expect(useCreateStore.getState().videoShots).toEqual(['', ''])
    expect(screen.getByText('Shot 2')).toBeTruthy()
    expect(screen.getByText('Shot 3')).toBeTruthy()
    expect(screen.queryByText('Shot 4')).toBeNull()
    expect(screen.getByText(/Shot 1 is your prompt/i)).toBeTruthy()
  })

  it('schreibt in den Speicher und behaelt den Text, wenn die Zahl waechst oder schrumpft', () => {
    setup(LTX, 'ltx25')
    const s = useCreateStore.getState()
    s.setVideoShotCount(3)
    s.setVideoShot(0, 'a close-up')
    s.setVideoShot(1, 'a wide shot')
    s.setVideoShotCount(4)
    expect(useCreateStore.getState().videoShots).toEqual(['a close-up', 'a wide shot', ''])
    s.setVideoShotCount(2)
    expect(useCreateStore.getState().videoShots).toEqual(['a close-up'])
    s.setVideoShotCount(1)
    expect(useCreateStore.getState().videoShots).toEqual([])
    s.setVideoShotCount(99)
    expect(useCreateStore.getState().videoShots).toHaveLength(3)
  })

  it('ein Feld nimmt Tippen an', () => {
    setup(LTX, 'ltx25')
    useCreateStore.getState().setVideoShotCount(2)
    render(<ParamGroups />)
    fireEvent.change(screen.getByPlaceholderText(/describe the next shot/i), { target: { value: 'a close-up of her hands' } })
    expect(useCreateStore.getState().videoShots).toEqual(['a close-up of her hands'])
  })

  it('fehlt bei jedem anderen Videomodell', () => {
    setup(WAN, 'wan22')
    render(<ParamGroups />)
    expect(screen.queryByText('Shots')).toBeNull()
  })

  it('fehlt bei Animate, in der Cloud, bei Bildern und auf dem Mac', () => {
    setup(LTX, 'ltx25', 'animate')
    const a = render(<ParamGroups />)
    expect(screen.queryByText('Shots')).toBeNull()
    a.unmount()
    setup(LTX, 'ltx25')
    useCreateStore.setState({ backend: 'cloud' } as never)
    const c = render(<ParamGroups />)
    expect(screen.queryByText('Shots')).toBeNull()
    c.unmount()
    setup(LTX, 'ltx25')
    host.mlx = true
    render(<ParamGroups />)
    expect(screen.queryByText('Shots')).toBeNull()
  })

  it('steht nie im Prompt-Fenster: der Composer zeigt die Liste nicht', () => {
    setup(LTX, 'ltx25')
    useCreateStore.getState().setVideoShotCount(2)
    render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
    expect(screen.queryByText('Shots')).toBeNull()
    expect(screen.queryByPlaceholderText(/describe the next shot/i)).toBeNull()
  })
})
