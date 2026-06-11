import { useRef, useState } from "react"
import { createPortal } from "react-dom"

import { AnnotationLabel, useAnnotationLabels } from "../../utils/annotationLabels"
import AnnotationLabelsEditor from "./AnnotationLabelsEditor"

export { DEFAULT_ANNOTATION_LABELS as ANNOTATION_LABELS } from "../../utils/annotationLabels"

/** Keyboard shortcuts for placing / editing annotations on the chart. */
const ANNOTATION_SHORTCUTS = [
	{ key: "P", action: "Point annotation" },
	{ key: "I", action: "Interval annotation" },
	{ key: "1-9", action: "Select label" },
	{ key: "Del", action: "Remove selected" },
	{ key: "Esc", action: "Cancel" }
] as const

const LabelRow: React.FC<{ shortcut?: number; label: AnnotationLabel }> = ({ shortcut, label }) => {
	const markerRef = useRef<HTMLSpanElement>(null)
	const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null)

	const showTooltip = () => {
		const rect = markerRef.current?.getBoundingClientRect()
		if (rect) setTooltipPos({ left: rect.right + 8, top: rect.top + rect.height / 2 })
	}
	const hideTooltip = () => setTooltipPos(null)

	return (
		<div className="flex items-center gap-2 text-[11px]">
			{shortcut != null && (
				<span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent px-1 text-[10px] font-semibold text-over-background-medium">
					{shortcut}
				</span>
			)}
			<span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
			<span className="text-xs font-medium text-over-background-highest">{label.name}</span>
			<span
				ref={markerRef}
				onMouseEnter={showTooltip}
				onMouseLeave={hideTooltip}
				className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-background-accent text-[10px] font-semibold text-over-background-medium"
			>
				?
			</span>
			{tooltipPos && typeof document !== "undefined" && createPortal(
				<span
					style={{ position: "fixed", left: tooltipPos.left, top: tooltipPos.top, transform: "translateY(-50%)" }}
					className="pointer-events-none z-[9999] whitespace-nowrap rounded-md border border-background-accent bg-background px-2 py-1 text-[11px] text-over-background-highest shadow-lg"
				>
					{label.description}
				</span>,
				document.body
			)}
		</div>
	)
}

/**
 * Annotations tab body: the interaction "key" (keyboard shortcuts) and the label
 * legend (channel + segment labels with their colors and number shortcuts).
 */
const AnnotationsPanel: React.FC = () => {
	const { labels } = useAnnotationLabels()
	const [editing, setEditing] = useState(false)

	const channelLabels = labels.filter(label => label.appliesTo === "channel")
	const segmentLabels = labels.filter(label => label.appliesTo === "segment")

	return (
		<div className="space-y-4 pr-1 text-over-background-highest">
			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Key's Shortcuts</p>
				<div className="mt-3 flex flex-col gap-2">
					{ANNOTATION_SHORTCUTS.map(shortcut => (
						<div key={shortcut.key} className="flex items-center gap-2 text-xs">
							<span className="inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold text-over-background-highest">
								{shortcut.key}
							</span>
							<span className="text-over-background-medium text-xs">{shortcut.action}</span>
						</div>
					))}
				</div>
			</div>

			<div className="flex items-center justify-between">
				<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Labels</p>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="rounded-md border border-background-accent px-2 py-1 text-[11px] text-over-background-medium transition-colors hover:border-primary hover:text-primary"
				>
					Edit labels
				</button>
			</div>

			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Channel labels</p>
				<div className="mt-3 flex flex-col gap-2 text-xs">
					{channelLabels.map((label, index) => (
						<LabelRow key={label.id} shortcut={index + 1} label={label} />
					))}
				</div>
			</div>

			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Segment labels</p>
				<div className="mt-3 flex flex-col gap-2 text-xs">
					{segmentLabels.map(label => (
						<LabelRow key={label.id} label={label} />
					))}
				</div>
			</div>

			<AnnotationLabelsEditor open={editing} onClose={() => setEditing(false)} />
		</div>
	)
}

export default AnnotationsPanel
