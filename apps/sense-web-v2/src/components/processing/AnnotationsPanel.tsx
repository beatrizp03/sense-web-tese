import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import { AnnotationLabel } from "../../utils/annotationLabels"
import { AnnotationMode } from "../../hooks/useAnnotations"
import AnnotationLabelsEditor, { MAX_CHANNEL_LABELS } from "./AnnotationLabelsEditor"
import HelpHint from "./HelpHint"

export { DEFAULT_ANNOTATION_LABELS as ANNOTATION_LABELS } from "../../utils/annotationLabels"

export interface AnnotationListItem {
	id: string
	t0: number
	t1: number
	color: string
	labelId: number
	labelName: string
	note: string
}

function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
	if (!match) return hex
	const int = parseInt(match[1], 16)
	const r = (int >> 16) & 255
	const g = (int >> 8) & 255
	const b = int & 255
	return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatTimeTenths(seconds: number): string {
	const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
	const m = Math.floor(sec / 60)
	const s = sec % 60
	return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`
}

interface AnnotationsPanelProps {
	labels?: AnnotationLabel[]
	annotationCount?: number
	dirty?: boolean
	saving?: boolean
	onSave?: () => void | Promise<void>
	mode?: AnnotationMode
	onToggleMode?: (mode: Exclude<AnnotationMode, "idle">) => void
	activeLabelId?: number | null
	onSelectLabel?: (id: number) => void
	items?: AnnotationListItem[]
	selectedId?: string | null
	onSelectAnnotation?: (id: string | null) => void
	onRemoveAnnotation?: (id: string) => void
	onSetNote?: (id: string, note: string) => void
	onSetLabel?: (id: string, labelId: number) => void
	onSetBounds?: (id: string, t0: number, t1: number) => void
	onClearAll?: () => void
	onUndo?: () => void
	onRedo?: () => void
	canUndo?: boolean
	canRedo?: boolean
	onLabelsChange?: (labels: AnnotationLabel[]) => void
}

const TOOLS: { mode: Exclude<AnnotationMode, "idle">; label: string; shortcut: string }[] = [
	{ mode: "point", label: "Point", shortcut: "P" },
	{ mode: "interval", label: "Interval", shortcut: "I" }
]

const formatSeconds = (value: number): string => String(Math.round(value * 1000) / 1000)

const TimeBoundInput: React.FC<{ label: string; value: number; onCommit: (value: number) => void }> = ({
	label,
	value,
	onCommit
}) => {
	const [text, setText] = useState(() => formatSeconds(value))

	useEffect(() => {
		setText(formatSeconds(value))
	}, [value])

	const commit = () => {
		const parsed = Number(text)
		if (Number.isFinite(parsed) && parsed >= 0) onCommit(parsed)
		else setText(formatSeconds(value))
	}

	return (
		<label className="flex flex-1 flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-wide text-over-background-low">{label}</span>
			<input
				type="number"
				step="0.1"
				min={0}
				value={text}
				onChange={event => setText(event.target.value)}
				onBlur={commit}
				onKeyDown={event => {
					if (event.key === "Enter") commit()
					else if (event.key === "Escape") setText(formatSeconds(value))
				}}
				className="w-full rounded border border-background-accent bg-background px-2 py-1 text-xs tabular-nums text-over-background-highest outline-none focus:border-primary"
			/>
		</label>
	)
}

/**
 * Annotations tab body.
 */
const AnnotationsPanel: React.FC<AnnotationsPanelProps> = ({
	labels = [],
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
	onSetNote,
	onSetLabel,
	onSetBounds,
	onClearAll,
	onUndo,
	onRedo,
	canUndo = false,
	canRedo = false,
	onLabelsChange
}) => {
	const [editing, setEditing] = useState(false)
	const [editorAutoAdd, setEditorAutoAdd] = useState(false)
	const [editorAutoAddAppliesTo, setEditorAutoAddAppliesTo] = useState<"channel" | "segment" | null>(null)
	const [helpOpen, setHelpOpen] = useState(false)
	const [capTooltip, setCapTooltip] = useState<{ x: number; y: number } | null>(null)

	const openLabelsEditor = (autoAdd: boolean, appliesTo: "channel" | "segment" | null = null) => {
		setEditorAutoAdd(autoAdd)
		setEditorAutoAddAppliesTo(appliesTo)
		setEditing(true)
	}

	const listRef = useRef<HTMLDivElement>(null)
	const selectedRowRef = useRef<HTMLDivElement>(null)
	const noteInputRef = useRef<HTMLInputElement>(null)
	const [maxHeight, setMaxHeight] = useState<number>()

	useEffect(() => {
		const list = listRef.current
		if (!list || items.length <= 5) {
			setMaxHeight(undefined)
			return
		}
		const rows = list.children
		const first = rows[0] as HTMLElement | undefined
		const fifth = rows[4] as HTMLElement | undefined
		if (!first || !fifth) return
		setMaxHeight(fifth.offsetTop - first.offsetTop + first.offsetHeight / 2)
	}, [items, selectedId])

	useEffect(() => {
		if (!selectedId) return
		const list = listRef.current
		const row = selectedRowRef.current
		if (list && row) {
			const lr = list.getBoundingClientRect()
			const rr = row.getBoundingClientRect()
			if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top
			else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom
		}
		noteInputRef.current?.focus({ preventScroll: true })
	}, [selectedId])

	const channelLabels = labels.filter(label => label.appliesTo === "channel" && !label.retired)
	const segmentLabels = labels.filter(label => label.appliesTo === "segment" && !label.retired)
	const atLabelCap = channelLabels.length >= MAX_CHANNEL_LABELS

	return (
		<div className="space-y-4 pr-1 text-over-background-highest">
			<div className="rounded-xl border border-background-accent bg-background-accent p-3">
				<div className="flex items-center justify-between gap-2">
					<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">
						{annotationCount} annotation{annotationCount === 1 ? "" : "s"} on this segment
					</p>
					<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onUndo}
						disabled={!canUndo}
						title="Undo (Ctrl+Z)"
						aria-label="Undo"
						className="rounded text-xs border border-background-accent px-1.5 py-0.5 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary disabled:opacity-90"
					>
						↶ Undo
					</button>
					<button
						type="button"
						onClick={onRedo}
						disabled={!canRedo}
						title="Redo (Ctrl+Shift+Z)"
						aria-label="Redo"
						className="rounded text-xs border border-background-accent px-1.5 py-0.5 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary disabled:opacity-90"
					>
						↷ Redo
					</button>
					</div>
				</div>

				{items.length === 0 ? (
					<p className="mt-3 text-xs text-over-background-low">No annotations yet.</p>
				) : (
					<div
						ref={listRef}
						style={{ maxHeight }}
						className="table-scroll mt-3 flex flex-col gap-1 overflow-y-auto pr-1"
					>
						{items.map(item => {
							const selected = item.id === selectedId
							const isPoint = item.t0 === item.t1
							return (
								<div
									key={item.id}
									ref={selected ? selectedRowRef : undefined}
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
											{isPoint ? (
												<span
													className="h-0 w-0 shrink-0"
													style={{
														borderLeft: "5px solid transparent",
														borderRight: "5px solid transparent",
														borderTop: `8px solid ${item.color}`
													}}
												/>
											) : (
												<span
													className="h-3 w-3 shrink-0"
													style={{
														borderLeft: `2px solid ${item.color}`,
														borderRight: `2px solid ${item.color}`,
														backgroundColor: hexToRgba(item.color, 0.16)
													}}
												/>
											)}
											<span className="shrink-0 text-xs capitalize text-over-background-highest">
												{isPoint ? "point" : "interval"}
											</span>
											<span className="shrink-0 tabular-nums text-over-background-medium text-xs">
												{isPoint
													? formatTimeTenths(item.t0)
													: `${formatTimeTenths(item.t0)} – ${formatTimeTenths(item.t1)}`}
											</span>
											{!selected && item.note && (
												<span className="truncate pr-1 text-xs italic text-over-background-low">
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
										<div
											className="space-y-2 px-2 pb-2"
											onKeyDown={event => {
												// Enter/Esc close the annotation from anywhere in the editor
												// (e.g. right after picking a colour swatch), not just the input.
												if (event.key === "Enter" || event.key === "Escape") {
													event.preventDefault()
													onSelectAnnotation?.(null)
												}
											}}
										>
											{/* Label picker — colour swatches; name shown on hover */}
											<div className="flex flex-wrap items-center gap-2">
												{channelLabels.map(label => {
													const active = label.id === item.labelId
													return (
														<span
															key={label.id}
															className="group/swatch relative inline-flex"
														>
															<button
																type="button"
																onClick={() => onSetLabel?.(item.id, label.id)}
																aria-label={label.name}
																className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
																	active
																		? "ring-2 ring-primary ring-offset-1 ring-offset-background-accent"
																		: ""
																}`}
																style={{ backgroundColor: label.color }}
															/>
															<span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-background-accent bg-background px-1.5 py-0.5 text-xs text-over-background-highest opacity-0 shadow-md transition-opacity group-hover/swatch:opacity-100">
																{label.name}
															</span>
														</span>
													)
												})}
											</div>

											{/* Description */}
											<input
												ref={noteInputRef}
												type="text"
												value={item.note}
												onChange={event => onSetNote?.(item.id, event.target.value)}
												onKeyDown={event => {
													if (event.key === "Escape" || event.key === "Enter") {
														event.preventDefault()
														onSelectAnnotation?.(null)
													} else if (event.key === "Delete") {
														event.preventDefault()
														onRemoveAnnotation?.(item.id)
													}
												}}
												placeholder="Add a note..."
												className="w-full rounded border border-background-accent bg-background py-1 pl-3 pr-3 text-xs text-over-background-highest outline-none focus:border-primary"
											/>
										</div>
									)}
								</div>
							)
						})}
					</div>
				)}

				<div className="mt-3 flex items-center justify-between gap-2 pr-2">
					<button
						type="button"
						onClick={onClearAll}
						disabled={items.length === 0}
						className="flex h-12 flex-1 uppercase pl-2 pr-2 basis-0 min-w-0 px-6 items-center justify-center rounded-lg bg-over-background-low px-2 text-center text-xs leading-tight text-background-white transition hover:opacity-80 disabled:opacity-40"
					>
						Clear window annotations
					</button>
					<TextButton
						size="base"
						onClick={onSave}
						disabled={saving || !dirty}
						className={`flex h-12 flex-1 basis-0 pl-2 pr-2 min-w-0 items-center justify-center px-4 text-center !text-xs leading-tight motion-safe:hover:!scale-95 ${!dirty && !saving ? "opacity-30" : ""}`}
					>
						{saving ? "Saving…" : dirty ? "Save Session Annotations" : "Annotations saved"}
					</TextButton>
				</div>
			</div>

			<div className="rounded-lg border border-background-accent bg-background px-3 py-2 text-xs text-over-background-medium">
				<button
					type="button"
					onClick={() => setHelpOpen(open => !open)}
					className={`flex w-full items-center justify-between text-xs uppercase tracking-[0.18em] text-over-background-low ${helpOpen ? "border-b border-background-accent pb-2" : ""}`}
				>
					<span className="text-xs">How to annotate</span>
					<span aria-hidden className="text-xs leading-none">{helpOpen ? "▾" : "▸"}</span>
				</button>
				{helpOpen && (
				<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
					<span className="basis-full text-[10px] font-semibold uppercase tracking-[0.18em] text-over-background-low">
						Window annotations
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">Point</kbd>
						- P + click on graph
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">Interval</kbd>
						- I + click twice on the graph
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex items-center rounded border border-background-accent px-1 text-xs font-semibold leading-tight">Window Label</kbd>
						- Select 1-9 Label (keyboard shortcut) or click a colour swatch
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">Move P / I</kbd>
						- Click and drag an annotation
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">Resize I</kbd>
						- Click and drag the ends
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">Select</kbd>
						- Double-click an annotation
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">↶ Undo</kbd>
						- Ctrl+Z
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex h-4 items-center justify-center rounded border border-background-accent px-1 text-xs font-semibold">↷ Redo</kbd>
						- Ctrl+Shift+Z / Ctrl+Y
					</span>

					<span className="mt-1 basis-full text-[10px] font-semibold uppercase tracking-[0.18em] text-over-background-low">
						Segment labels
					</span>
					<span className="inline-flex items-center gap-1.5 text-xs">
						<kbd className="inline-flex items-center rounded border border-background-accent px-1 text-xs font-semibold leading-tight">Label segment</kbd>
						- Click a segment at the top, then click it again to pick a label
					</span>
				</div>
				)}
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
				<p className="mt-1.5 text-[10px] text-over-background-low">
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
						onClick={() => openLabelsEditor(false)}
						className="rounded-md border border-background-accent px-2 py-1 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
					>
						Edit labels
					</button>
				</div>
				<p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-over-background-low">
					Window
				</p>
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
										: "border border-background-accent hover:bg-background-accent"
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
					<button
						type="button"
						onClick={() => openLabelsEditor(true, "channel")}
						onMouseMove={atLabelCap ? event => setCapTooltip({ x: event.clientX, y: event.clientY }) : undefined}
						onMouseLeave={atLabelCap ? () => setCapTooltip(null) : undefined}
						className="inline-flex items-center gap-2 rounded-full border border-dashed border-background-accent px-3 py-1.5 text-left text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
					>
						<span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-xs leading-none">+</span>
						New label
					</button>
				</div>

				<p className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-[0.18em] text-over-background-low">
					Segment
				</p>
				<div className="flex flex-wrap items-center gap-1.5">
					{segmentLabels.map(label => (
						<span
							key={label.id}
							className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-background-accent bg-background-accent-light px-2 py-1 text-xs text-over-background-medium dark:bg-background-accent-dark"
						>
							<span
								className="h-2.5 w-2.5 shrink-0 rounded-full"
								style={{ backgroundColor: label.color }}
							/>
							{label.name}
							<HelpHint label={`About ${label.name}`} width="w-[14rem]">
								<span className="text-xs text-over-background-highest">{label.description}</span>
							</HelpHint>
						</span>
					))}

					<button
						type="button"
						onClick={() => openLabelsEditor(true, "segment")}
						onMouseMove={atLabelCap ? event => setCapTooltip({ x: event.clientX, y: event.clientY }) : undefined}
						onMouseLeave={atLabelCap ? () => setCapTooltip(null) : undefined}
						className="inline-flex items-center gap-2 rounded-full border border-dashed border-background-accent px-3 py-1.5 text-left text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
					>
						<span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-xs leading-none">+</span>
						New label
					</button>
				</div>
				<p className="mt-1.5 text-[10px] text-over-background-low">
					Click on a segment to set or change its label
				</p>
			</div>

			<AnnotationLabelsEditor
				open={editing}
				onClose={() => {
					setEditing(false)
					setEditorAutoAdd(false)
					setEditorAutoAddAppliesTo(null)
				}}
				value={labels}
				onSave={onLabelsChange}
				autoAddOnOpen={editorAutoAdd}
				autoAddOnOpenAppliesTo={editorAutoAddAppliesTo ?? undefined}
			/>

			{capTooltip && typeof document !== "undefined" &&
				createPortal(
					<div
						className="pointer-events-none fixed z-[100] w-max max-w-[18rem] rounded-md border border-background-accent bg-background px-2 py-1 text-xs text-over-background-highest shadow-lg"
						style={{ left: capTooltip.x - 12, top: capTooltip.y + 12, transform: "translateX(-100%)" }}
					>
						{MAX_CHANNEL_LABELS}/{MAX_CHANNEL_LABELS} window labels taken - this one will be a segment label
					</div>,
					document.body
				)}
		</div>
	)
}

export default AnnotationsPanel
