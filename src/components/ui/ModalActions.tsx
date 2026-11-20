import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * The button bar of a dialog: one place, one order, one size.
 *
 * It sits at the bottom of a `Modal` with the default padding (`p-6`) and
 * reaches to the panel edges with a hairline above it. Buttons stand on the
 * right, the main action last. `stack` lays them out one below the other at
 * full width, for labels too long to share a row.
 */
export function ModalActions({ children, stack = false, className = '' }: { children: ReactNode; stack?: boolean; className?: string }) {
  return (
    <div
      data-modal-actions
      className={`lu-dialog-actions -mx-6 -mb-6 mt-5 px-6 py-3 flex ${stack ? 'flex-col items-stretch gap-2' : 'flex-wrap items-center justify-end gap-2'} ${className}`}
    >
      {children}
    </div>
  )
}

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  /** `primary` is the main action (the house accent recipe), `secondary` a
   *  second real choice, `quiet` the way out, `danger` an action that removes. */
  variant?: Variant
}

const VARIANT: Record<Variant, string> = {
  primary: 'lu-primary',
  secondary: 'lu-dialog-btn-secondary',
  quiet: 'lu-dialog-btn-quiet',
  danger: 'lu-dialog-btn-danger',
}

export function ModalButton({ children, variant = 'secondary', className = '', type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={`lu-dialog-btn ${VARIANT[variant]} ${className}`} {...props}>
      {children}
    </button>
  )
}
