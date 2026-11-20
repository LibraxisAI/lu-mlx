/**
 * The elements of the window in front, each with a number.
 *
 * The system reports the buttons and fields of a window with their places.
 * A model used to get those places as rectangles and had to work out the
 * middle of one and click it as a coordinate. A small text model is bad at
 * that sum and clicks beside the button. Here every element gets a short
 * number, the model names the number, and the app works out the place.
 * (The way Windows-MCP, Microsoft UFO and Cua Driver do it; the token per
 * element follows Cua Driver, trycua/cua, MIT licence.)
 *
 * A number stays with its element for the whole session: the same button
 * has the same number in the next list. So after an action only the lines
 * that changed need to be told, not the whole list again.
 */

import type { TreeNode } from '../../api/computer'

export interface ListedElement {
  id: number
  line: string
  /** The middle of the element on the 0..1000 grid. */
  x: number
  y: number
}

export interface ListChange {
  added: string[]
  removed: string[]
  /** Nothing was listed before: there is nothing to compare with. */
  first: boolean
}

/** More changed lines than this and the whole list is the shorter answer. */
export const MAX_CHANGE_LINES = 30

/** An element without a place cannot be pointed at. Its middle would be the corner of the screen. */
function placed(node: TreeNode): boolean {
  const [left, top, right, bottom] = node.rect
  return right > left && bottom > top
}

function keyOf(node: TreeNode): string {
  return `${node.role}|${node.name}|${node.rect.join(',')}`
}

function lineOf(id: number, node: TreeNode, x: number, y: number): string {
  const flags = [node.state ?? '', node.enabled ? '' : 'disabled', node.focused ? 'focused' : '', node.password ? 'password field' : ''].filter(Boolean).join(', ')
  // What a field holds stands in the line: the model checks its own typing with it,
  // and a box that was ticked is a line that changed.
  const value = node.value && !node.password ? ` = "${node.value}"` : ''
  return `[${id}] ${node.role} "${node.name}"${value} at ${x}, ${y}${flags ? ` (${flags})` : ''}`
}

export class ElementList {
  private ids = new Map<string, number>()
  private next = 1
  private now = new Map<number, ListedElement>()
  private listed = false

  /** Take the list the system just reported. Answers with what changed since the one before. */
  update(nodes: readonly TreeNode[]): ListChange {
    const before = this.now
    const after = new Map<number, ListedElement>()
    for (const node of nodes) {
      if (!placed(node)) continue
      const key = keyOf(node)
      let id = this.ids.get(key)
      // Two elements with the same role, name and place are one for every purpose here.
      if (id !== undefined && after.has(id)) continue
      if (id === undefined) {
        id = this.next++
        this.ids.set(key, id)
      }
      const x = Math.round((node.rect[0] + node.rect[2]) / 2)
      const y = Math.round((node.rect[1] + node.rect[3]) / 2)
      after.set(id, { id, line: lineOf(id, node, x, y), x, y })
    }
    const added: string[] = []
    const removed: string[] = []
    for (const [id, item] of after) {
      const old = before.get(id)
      if (!old || old.line !== item.line) added.push(item.line)
    }
    for (const [id, item] of before) {
      if (!after.has(id)) removed.push(item.line)
    }
    const first = !this.listed
    this.now = after
    this.listed = true
    return { added, removed, first }
  }

  /** The lines of the current list, optionally only those that contain `query`. */
  lines(query?: string): string[] {
    const all = [...this.now.values()].map((item) => item.line)
    const wanted = query?.trim().toLowerCase()
    return wanted ? all.filter((line) => line.toLowerCase().includes(wanted)) : all
  }

  get size(): number {
    return this.now.size
  }

  /** A list was read in this session, so the model works from it. */
  get active(): boolean {
    return this.listed
  }

  find(id: number): ListedElement | null {
    return this.now.get(id) ?? null
  }

  /** The session ended: numbers start again. */
  clear(): void {
    this.ids.clear()
    this.now = new Map()
    this.next = 1
    this.listed = false
  }
}

/** What changed, as a sentence and the lines it is about. Null when the whole list is the better answer. */
export function changeText(change: ListChange): { head: string; rows: string[] } | null {
  if (change.first) return null
  const count = change.added.length + change.removed.length
  if (count === 0) return { head: 'The list of elements did not change.', rows: [] }
  if (count > MAX_CHANGE_LINES) return null
  return {
    head: 'Changed in the list of elements (+ new or different now, - gone):',
    rows: [...change.added.map((line) => `+ ${line}`), ...change.removed.map((line) => `- ${line}`)],
  }
}
