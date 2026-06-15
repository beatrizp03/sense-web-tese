import { useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import { useAnnotationLabels } from "../../utils/annotationLabels"
import { AnnotationMode, AnnotationType } from "../../hooks/useAnnotations"
import AnnotationLabelsEditor from "./AnnotationLabelsEditor"
import HelpHint from "./HelpHint"

export { DEFAULT_ANNOTATION_LABELS as ANNOTATION_LABELS } from "../../utils/annotationLabels"

export interface AnnotationListItem {
	id: string
	type: AnnotationType
	startSec: number
	endSec: number
	color: string
	labelName: string
	note: string
}

function formatTimeTenths(seconds: number): string {
	const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
	const m = Math.floor(sec / 60)
	const s = sec % 60
	return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`
}

interface AnnotationsPanelProps {
	annotationCount?: number
	dirty?: boolean
	saving?: boolean
	onSave?: () => void
	mode?: AnnotationMode
	onToggleMode?: (mode: Exclude<AnnotationMode, "idle">) => void
	activeLabelId?: number | null
	onSelectLabel?: (id: number) => void
	items?: AnnotationListItem[]
	selectedId?: string | null
	onSelectAnnotation?: (id: string | null) => void
	onRemoveAnnotation?: (id: string) => void
	onSetNote?: (id: string, note: string) => void
}

const TOOLS: { mode: Exclude<AnnotationMode, "idle">; label: string; shortcut: string }[] = [
	{ mode: "point", label: "Point", shortcut: "P" },
	{ mode: "interval", label: "Interval", shortcut: "I" }
]

/**
 * Annotations tab body.
 */
const AnnotationsPanel: React.FC<AnnotationsPanelProps> = ({
	annotationCount = 0,
	dirty = false,
	saving = false,
	onSave,
	mode = "idle",
	onToggleMode,
	activeLabelId = null,
	onSelectLabel,
	items = [],
	selectedId = null,
	onSelectAnnotation,
	onRemoveAnnotation,
	onSetNote
}) => {
	const { labels } = useAnnotationLabels()
	const [editing, setEditing] = useState(false)

	const channelLabels = labels.filter(label => label.appliesTo === "channel")
	const segmentLabels = labels.filter(label => label.appliesTo === "segment")

	return (
		<div className="space-y-4 pr-1 text-over-background-highest">
			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<div className="flex items-center justify-between">
					<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">
						{annotationCount} annotation{annotationCount === 1 ? "" : "s"} on this segment
					</p>
					{dirty && (
						<span className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-500">
							Unsaved
						</span>
					)}
				</div>

				{items.length === 0 ? (
					<p className="mt-3 text-xs text-over-background-low">No annotations yet.</p>
				) : (
					<div className="mt-3 flex flex-col gap-1">
						{items.map(item => {
							const selected = item.id === selectedId
							return (
								<div
									key={item.id}
									className={`group rounded-md border transition-colors ${
										selected
											? "border-primary bg-primary/10"
											: "border-transparent hover:bg-background"
									}`}
								>
									<div className="flex items-center gap-2 px-2 py-1.5 text-xs">
										<button
											type="button"
											onClick={() => onSelectAnnotation?.(selected ? null : item.id)}
											className="flex min-w-0 flex-1 items-center gap-2 text-left"
										>
											<span
												className="h-3 w-3 shrink-0 rounded-full"
												style={{ backgroundColor: item.color }}
											/>
											<span className="shrink-0 text-xs capitalize text-over-background-highest">
												{item.type}
											</span>
											<span className="shrink-0 tabular-nums text-over-background-medium text-xs">
												{item.type === "interval"
													? `${formatTimeTenths(item.startSec)} – ${formatTimeTenths(item.endSec)}`
													: formatTimeTenths(item.startSec)}
											</span>
											{!selected && item.note && (
												<span className="truncate text-xs italic text-over-background-low">
													{item.note}
												</span>
											)}
										</button>
										<button
											type="button"
											onClick={() => onRemoveAnnotation?.(item.id)}
											aria-label="Remove annotation"
											className="shrink-0 rounded px-1 text-over-background-low opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
										>
											✕
										</button>
									</div>
									{selected && (
										<div className="px-2 pb-2">
											<input
												type="text"
												value={item.note}
												onChange={event => onSetNote?.(item.id, event.target.value)}
												placeholder="Add a description…"
												autoFocus
												className="w-full rounded border border-background-accent bg-background px-2 py-1 text-xs text-over-background-highest outline-none focus:border-primary"
											/>
										</div>
									)}
								</div>
							)
						})}
					</div>
				)}

				<div className="mt-3 flex justify-center">
					<TextButton
						size="base"
						onClick={onSave}
						disabled={saving || !dirty}
						className="px-6 text-xs"
					>
						{saving ? "Saving…" : "Save annotations"}
					</TextButton>
				</div>
			</div>
			<div>
				<p className="mb-2 text-xs uppercase tracking-[0.2em] text-over-background-low">
					1 - Tool
				</p>
				<div className="grid grid-cols-2 gap-2">
					{TOOLS.map(tool => {
						const active = mode === tool.mode
						return (
							<button
								key={tool.mode}
								type="button"
								onClick={() => onToggleMode?.(tool.mode)}
								className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs text-xs transition-colors ${
									active
										? "border-primary bg-primary/10 text-over-background-highest"
										: "border-background-accent bg-background-accent text-over-background-medium hover:border-primary/60"
								}`}
							>
								{tool.label}
								<span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent-dark px-1 text-xs font-semibold dark:border-background-accent-light">
									{tool.shortcut}
								</span>
							</button>
						)
					})}
				</div>
				<p className="mt-1.5 text-xs text-over-background-low">
					Click the chart to place · Esc cancels · Del removes selected
				</p>
			</div>

			<div>
				<div className="mb-2 flex items-center justify-between">
					<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">
						2 - Label
					</p>
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="rounded-md border border-background-accent px-2 py-1 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
					>
						Edit labels
					</button>
				</div>
				<div className="flex flex-col gap-1.5">
					{channelLabels.map((label, index) => {
						const active = activeLabelId === label.id
						return (
							<button
								key={label.id}
								type="button"
								onClick={() => onSelectLabel?.(label.id)}
								className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
									active
										? "border-2 border-primary bg-primary/10"
										: "border border-over-background-highest hover:bg-background-accent"
								}`}
							>
								{index < 9 && (
									<span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold text-over-background-medium">
										{index + 1}
									</span>
								)}
								<span
									className="h-3 w-3 shrink-0 rounded-full"
									style={{ backgroundColor: label.color }}
								/>
								<span className="text-xs text-over-background-highest">{label.name}</span>
								<span className="ml-auto">
									<HelpHint label={`About ${label.name}`} width="w-[14rem]">
										<span className="text-xs text-over-background-highest">{label.description}</span>
									</HelpHint>
								</span>
							</button>
						)
					})}
				</div>
			</div>

			{/* Segment labels legend */}
			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Segment labels</p>
				<div className="mt-3 flex flex-col gap-2 text-xs">
					{segmentLabels.map(label => (
						<div key={label.id} className="flex items-center gap-2 text-xs">
							<span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
							<span className="text-xs text-xs text-over-background-highest">{label.name}</span>
							<HelpHint label={`About ${label.name}`} width="w-[14rem]">
								<span className="text-xs text-over-background-highest">{label.description}</span>
							</HelpHint>
						</div>
					))}
				</div>
			</div>

			<AnnotationLabelsEditor open={editing} onClose={() => setEditing(false)} />
		</div>
	)
}

export default AnnotationsPanel
