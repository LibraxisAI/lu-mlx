/**
 * The image model files the Qwen-Image 2.1 lane runs, for the tests that are
 * parametrised over them: whatever the family does has to come out the same
 * with either file in the UNETLoader.
 *
 *   - the official weights (Comfy-Org/Qwen-Image-2.1)
 *   - Noct Q V4 (Noctaluna/Noct-Q-Uncensored-Qwen-Image-2.1), a community
 *     finetune with the same tensor names, shapes and data types
 */
export const QWEN21_OFFICIAL_MODEL = 'qwen_image_2.1_int8_convrot.safetensors'
export const NOCT_Q_MODEL = 'NoctQ_V4_int8_convrot.safetensors'

export const QWEN21_WEIGHTS: [label: string, file: string][] = [
  ['official weights', QWEN21_OFFICIAL_MODEL],
  ['Noct Q', NOCT_Q_MODEL],
]
