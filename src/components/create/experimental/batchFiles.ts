// Reading the files of a drop or of a picked folder, for the list of several
// source images (lib/batch-edit).

function readFolder(dir: FileSystemDirectoryEntry): Promise<File[]> {
  const reader = dir.createReader()
  const found: FileSystemEntry[] = []
  return new Promise<File[]>((resolve) => {
    // readEntries hands the folder out in chunks and ends with an empty one.
    const next = () => reader.readEntries((chunk) => {
      if (chunk.length === 0) {
        void Promise.all(found.filter((e) => e.isFile).map(entryFile)).then((files) => resolve(files.flatMap((f) => (f ? [f] : []))))
        return
      }
      found.push(...chunk)
      next()
    }, () => resolve([]))
    next()
  })
}

function entryFile(entry: FileSystemEntry): Promise<File | null> {
  return new Promise((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)))
}

/**
 * The files of a drop. A dropped folder gives its own images (not the ones in
 * folders below it). Call it inside the drop handler: the browser only hands
 * out the entries while the event is alive.
 */
export function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const plain = Array.from(dt.files)
  const entries = Array.from(dt.items ?? []).map((it) => (it.kind === 'file' && typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
  if (!entries.some((e) => e?.isDirectory)) return Promise.resolve(plain)
  return Promise.all(entries.map(async (e) => {
    if (!e) return []
    if (e.isDirectory) return readFolder(e as FileSystemDirectoryEntry)
    const f = await entryFile(e)
    return f ? [f] : []
  })).then((lists) => lists.flat())
}

/** A folder picker hands out every file below the folder. The batch takes the
 *  folder's own images. */
export function topLevelFiles(files: readonly File[]): File[] {
  return files.filter((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
    return rel.split('/').length <= 2
  })
}
