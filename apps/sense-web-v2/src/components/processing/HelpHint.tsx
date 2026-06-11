import { ReactNode, useRef, useState } from "react"
import { createPortal } from "react-dom"

interface HelpHintProps {
	children: ReactNode
	label?: string
	width?: string
	className?: string
}

type Anchor = { side: "left" | "right"; offset: number; top: number }

/**
 * A small "?" help icon that reveals a popover on hover/focus (never on click).
 */
const HelpHint: React.FC<HelpHintProps> = ({ children, label = "Help", width = "w-[24rem]", className = "" }) => {
	const ref = useRef<HTMLSpanElement>(null)
	const [anchor, setAnchor] = useState<Anchor | null>(null)

	const show = () => {
		const rect = ref.current?.getBoundingClientRect()
		if (!rect) return
		if (rect.left > window.innerWidth / 2) {
			setAnchor({ side: "right", offset: window.innerWidth - rect.right, top: rect.bottom + 8 })
		} else {
			setAnchor({ side: "left", offset: rect.left, top: rect.bottom + 8 })
		}
	}
	const hide = () => setAnchor(null)

	return (
		<span
			ref={ref}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			tabIndex={0}
			role="button"
			aria-label={label}
			className={`inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-background-accent text-[11px] font-semibold transition-colors hover:bg-background-accent ${anchor ? "bg-background-accent text-over-background-highest" : "text-over-background-medium"} ${className}`}
		>
			?
			{anchor && typeof document !== "undefined" &&
				createPortal(
					<div
						style={{
							position: "fixed",
							top: anchor.top,
							...(anchor.side === "right" ? { right: anchor.offset } : { left: anchor.offset })
						}}
						className={`pointer-events-none z-[9999] ${width} max-w-[80vw] rounded-xl border border-background-accent bg-background p-3 text-over-background-highest shadow-2xl`}
					>
						{children}
					</div>,
					document.body
				)}
		</span>
	)
}

export default HelpHint
