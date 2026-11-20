export const MLX_MODEL_PREFIX = 'MLX '

/** True when the given model name is a synthetic MLX image model. */
export function isMlxImageModel(name: string | null | undefined): boolean {
  return !!name && name.startsWith(MLX_MODEL_PREFIX)
}
