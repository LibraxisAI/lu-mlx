// @vitest-environment jsdom
/**
 * The LoRA stack in the Expert settings offers a LoRA from the catalogue only
 * where its family runs (03.10.2026): the MiniMax H3 turbo LoRA showed up on
 * the image model Z-Image, with its long file name cut off.
 *
 * The rule is lib/lora-stack.ts and has its own test. Here the real
 * ParamGroups is rendered with the real classifier, for the video lane the
 * Playwright spec (e2e/lora-stack-follows-the-folder.spec.ts) does not reach.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const lists = vi.hoisted(() => ({ loras: [] as string[] }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: lists.loras, vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { useCreateStore } from '../../../../stores/createStore'
import { classifyModel } from '../../../../api/comfyui'

const H3_TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
const TURBO_NAME = 'MiniMax H3 Turbo LoRA · 8 Steps'
const STYLE = 'film_grain_xl.safetensors'
const H3 = 'minimax_h3_fl2va_bf16.safetensors'
const Z_IMAGE = 'z_image_turbo_bf16.safetensors'

function setup(mode: 'image' | 'video', model: string, loras: string[], picks: string[] = []) {
  lists.loras = loras
  useCreateStore.setState({
    backend: 'local', isGenerating: false, cloudOp: null, utilityOp: null, removebg: false,
    // The section remembers its state while the app runs; each case starts closed.
    expertOpen: false,
    selectedLoras: picks.map((name) => ({ name, strength: 0.8 })),
    imageModel: mode === 'image' ? model : '', imageModelList: mode === 'image' ? [{ name: model, type: classifyModel(model) }] : [],
    videoModel: mode === 'video' ? model : '', videoModelList: mode === 'video' ? [{ name: model, type: classifyModel(model) }] : [],
  } as never)
  useCreateStore.getState().setIntent(mode === 'video' ? 'video' : 'image')
  render(<ParamGroups />)
  fireEvent.click(screen.getByRole('button', { name: 'Expert' }))
}
/** The rows of the stack: the buttons whose tooltip is a LoRA file name. */
const rowNames = () => screen.getAllByRole('button').filter((b) => /\.safetensors$/.test(b.getAttribute('title') ?? '')).map((b) => b.textContent)

afterEach(() => { cleanup() })

describe('the LoRA stack and the MiniMax H3 turbo LoRA', () => {
  it('MiniMax H3 lists it under its catalogue name, the file name is the tooltip', () => {
    setup('video', H3, [STYLE, H3_TURBO])
    const row = screen.getByRole('button', { name: new RegExp(TURBO_NAME) })
    expect(row.getAttribute('title')).toBe(H3_TURBO)
    expect(screen.queryByText(/minimax_h3_fl2v_turbo/)).toBeNull()
    expect(rowNames()).toEqual(['film_grain_xloff', `${TURBO_NAME}off`])
  })

  it('ticking it there counts it and stores the file name', () => {
    setup('video', H3, [STYLE, H3_TURBO])
    fireEvent.click(screen.getByRole('button', { name: new RegExp(TURBO_NAME) }))
    expect(useCreateStore.getState().selectedLoras.map((l) => l.name)).toEqual([H3_TURBO])
    expect(screen.getByText('· 1 active')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: `Strength of ${TURBO_NAME}` })).toBeTruthy()
  })

  it('the reported case: Z-Image does not list it', () => {
    setup('image', Z_IMAGE, [STYLE, H3_TURBO])
    expect(rowNames()).toEqual(['film_grain_xloff'])
    expect(screen.queryByText(new RegExp(TURBO_NAME))).toBeNull()
  })

  it('still ticked from a video run: Z-Image shows it as not for this model, does not count it, and it can be turned off', () => {
    setup('image', Z_IMAGE, [STYLE, H3_TURBO], [H3_TURBO])
    const row = screen.getByRole('button', { name: new RegExp(TURBO_NAME) })
    expect(row.textContent).toBe(`${TURBO_NAME}MiniMax H3 only`)
    expect(screen.queryByText(/active/)).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Strength of/ })).toBeNull()
    fireEvent.click(row)
    expect(useCreateStore.getState().selectedLoras).toEqual([])
    expect(screen.queryByText(new RegExp(TURBO_NAME))).toBeNull()
  })

  it('only LoRAs of other families in the folder: the stack says so instead of showing an empty list', () => {
    setup('image', Z_IMAGE, [H3_TURBO])
    expect(screen.getByText(/The LoRAs in models\/loras are made for other models\./)).toBeTruthy()
    expect(rowNames()).toEqual([])
  })
})
