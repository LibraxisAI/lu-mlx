// Draws the big view of a chat image over the whole app.
//
// The card (CreateMedia) is the web's file and draws its big view in place.
// On the desktop the card sits inside the thread, and the thread is painted
// under the title bar and the composer: a big view drawn in place had its
// Close button behind the title bar and its lower edge, where the prompt
// stands, behind the composer.
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function OverTheApp({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
