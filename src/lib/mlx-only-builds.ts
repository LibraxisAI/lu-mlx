// Ollama's MLX builds (NVFP4, MXFP8, MLX BF16) run on Apple Silicon only. On
// Windows the pull ends with "412: this model requires macOS" (Ollama issues
// 15157, 15686, 16056, 16265), so a PC does not get to see a Get button that
// cannot work.
import type { DiscoverModel } from '../api/discover'

export function isMlxOnlyBuild(m: Pick<DiscoverModel, 'tags' | 'ollamaModel'>): boolean {
  return Boolean(m.ollamaModel) && (m.tags ?? []).includes('MLX')
}

export function forThisPlatform<T extends Pick<DiscoverModel, 'tags' | 'ollamaModel'>>(models: T[], mac: boolean): T[] {
  return mac ? models : models.filter((m) => !isMlxOnlyBuild(m))
}
