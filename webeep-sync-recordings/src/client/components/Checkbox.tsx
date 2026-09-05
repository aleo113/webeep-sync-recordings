import React, { FC } from "react"
import { IconType } from "react-icons"
import { IoCheckbox, IoSquareOutline } from "react-icons/io5"

interface CheckboxProps {
  ariaLabel?: string
  value: boolean
  onChange: (v: boolean) => void
  color?: string
  PositiveIcon?: IconType
  NegativeIcon?: IconType
}

export const Checkbox: FC<CheckboxProps> = props => {
  const PositiveIcon = props.PositiveIcon ?? IoCheckbox
  const NegativeIcon = props.NegativeIcon ?? IoSquareOutline
  return (
    <div
      className="checkbox"
      role="checkbox"
      aria-checked={props.value}
      aria-label={props.ariaLabel}
      tabIndex={0}
      onClick={() => props.onChange(!props.value)}
      onKeyDown={event => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault()
          props.onChange(!props.value)
        }
      }}
      style={{ backgroundColor: props.value ? props.color : undefined }}
    >
      {props.value ? (
        <PositiveIcon className="active" />
      ) : (
        <NegativeIcon color={props.color} />
      )}
    </div>
  )
}
