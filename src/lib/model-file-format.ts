// 3.0.4 Gegenprobe (02.10.2026): Models, Installed called the AnimateDiff
// motion module v3_sd15_mm.ckpt "safetensors", because the card fell back to
// that word whenever no format was set. The file's own ending says it.

/** The format a model card shows: the set format, else the file ending. */
export function fileFormat(model: { format?: string; name: string }): string {
  if (model.format) return model.format
  const ext = /\.([a-z0-9]{2,12})$/i.exec(model.name)?.[1]
  return ext ? ext.toLowerCase() : ''
}
