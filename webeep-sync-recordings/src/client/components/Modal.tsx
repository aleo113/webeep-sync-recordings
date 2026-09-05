import React, { FC, useEffect, useRef, useState, useId } from "react"
import { IoClose } from "react-icons/io5"

export const Modal: FC<{
  onClose: () => void
  title: string
  style?: React.CSSProperties
  children: React.ReactNode
}> = props => {
  const [shadow, setShadow] = useState(false)
  const titleId = useId()

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => previous?.focus()
  }, [ref])

  return (
    <div
      ref={ref}
      className="modal-container"
      onClick={e => {
        if (e.target === e.currentTarget) props.onClose()
      }}
      tabIndex={-1}
      onKeyDown={e => {
        if (e.key === "Tab") {
          const focusable = Array.from(
            ref.current.querySelectorAll<HTMLElement>(
              "button, a[href], input, select, textarea, [tabindex]",
            ),
          ).filter(
            element =>
              element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length,
          )
          const first = focusable[0],
            last = focusable[focusable.length - 1]
          if (!first) {
            e.preventDefault()
            return
          }
          if (
            e.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === ref.current)
          ) {
            e.preventDefault()
            last.focus()
          } else if (
            !e.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === ref.current)
          ) {
            e.preventDefault()
            first.focus()
          }
        }
        if (e.key === "Escape") {
          e.preventDefault()
          props.onClose()
        }
      }}
    >
      <div
        className="modal"
        style={props.style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={`modal-header ${shadow ? "shadow" : undefined}`}>
          <h3 id={titleId}>{props.title}</h3>
        </div>
        <button
          type="button"
          className="close clickable modal-close"
          aria-label="Close"
          onClick={props.onClose}
        >
          <IoClose />
        </button>
        <div
          className="modal-content"
          onScroll={e => {
            if (e.currentTarget.scrollTop > 5 && !shadow) setShadow(true)
            else if (e.currentTarget.scrollTop <= 5 && shadow) setShadow(false)
          }}
        >
          {props.children}
        </div>
      </div>
    </div>
  )
}
