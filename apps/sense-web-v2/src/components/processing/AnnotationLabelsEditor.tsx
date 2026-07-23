import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import {
	AnnotationAppliesTo,
	AnnotationLabel,
	DEFAULT_ANNOTATION_LABELS,
	getAnnotationLabels,
	nextLabelId,
	setAnnotationLabels
} from "../../utils/annotationLabels"
import HelpHint from "./HelpHint"

interface AnnotationLabelsEditorProps {
	open: boolean
	onClose: () => void
	value?: AnnotationLabel[]
	onSave?: (labels: AnnotationLabel[]) => void
	autoAddOnOpen?: boolean
}

export const MAX_CHANNEL_LABELS = 9

const APPLIES_TO_OPTIONS: { value: AnnotationAppliesTo; label: string }[] = [
	{ value: "channel", label: "Windows" },
	{ value: "segment", label: "Segment" }
]

const SECTIONS: { value: AnnotationAppliesTo; title: string; empty: string }[] = [
	{ value: "channel", title: "Window labels", empty: "No window labels yet." },
	{ value: "segment", title: "Segment labels", empty: "No segment labels yet." }
]

const fieldClasses =
	"h-[1.875rem] min-w-0 rounded-md border border-background-accent bg-background px-2 text-xs text-over-background-highest outline-none focus:border-primary"

const fieldLabelClasses = "text-[10px] font-medium uppercase tracking-wide text-over-background-low"

/** Per-field guidance shown in the "?" help panel so users know what to enter. */
const FIELD_GUIDE: { field: string; help: string; example: string }[] = [
	{ field: "Color", help: "The marker color shown on the chart for this label.", example: "e.g. red for artifacts, green for events" },
	{ field: "Label", help: "Short name you'll pick while annotating.", example: "e.g. noise, onset, peak" },
	{ field: "Applies to", help: "Whether the label marks a point/interval on the windows, or a whole segment.", example: "e.g. Windows for a noisy stretch, Segment for \"healthy\"" },
	{ field: "Category", help: "A group the label belongs to, for organisation.", example: "e.g. quality, event, feature, state, class" },
	{ field: "Description", help: "A longer explanation, shown as a tooltip in the legend.", example: "e.g. \"Motion artifact\", \"Event start\"" }
]

/**
 * Pop-up editor for annotation labels (add / rename / recolor / delete).
 */
const AnnotationLabelsEditor: React.FC<AnnotationLabelsEditorProps> = ({ open, onClose, value, onSave, autoAddOnOpen }) => {
	const [draft, setDraft] = useState<AnnotationLabel[]>([])
	const [lastAddedId, setLastAddedId] = useState<number | null>(null)
	const [openPickerFor, setOpenPickerFor] = useState<number | null>(null)
	const [capNote, setCapNote] = useState<{ x: number; y: number } | null>(null)

	const listRef = useRef<HTMLDivElement>(null)
	const newRowRef = useRef<HTMLDivElement>(null)
	const newNameInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (!open) {
			setDraft([])
			setLastAddedId(null)
			setOpenPickerFor(null)
			setCapNote(null)
			return
		}
		const base = (value ?? getAnnotationLabels()).map(label => ({ ...label }))
		const channelActive = base.filter(label => label.appliesTo === "channel" && !label.retired).length
		if (autoAddOnOpen) {
			const id = nextLabelId(base)
			setDraft([
				...base,
				{ id, name: "new label", category: "custom", description: "", color: "#888888", appliesTo: channelActive >= MAX_CHANNEL_LABELS ? "segment" : "channel", predefined: false, retired: false }
			])
			setLastAddedId(id)
		} else {
			setDraft(base)
			setLastAddedId(null)
		}
	}, [open])

	useEffect(() => {
		if (lastAddedId == null) return
		newRowRef.current?.scrollIntoView({ block: "nearest" })
		newNameInputRef.current?.focus({ preventScroll: true })
		newNameInputRef.current?.select()
	}, [lastAddedId])

	useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose()
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [open, onClose])

	if (!open || typeof document === "undefined") return null

	const visible = draft.filter(label => !label.retired)
	const activeChannelCount = (list: AnnotationLabel[]) =>
		list.filter(label => label.appliesTo === "channel" && !label.retired).length
	const channelCount = activeChannelCount(draft)
	const atChannelCap = channelCount >= MAX_CHANNEL_LABELS

	const updateDraft = (id: number, patch: Partial<AnnotationLabel>) =>
		setDraft(current => {
			if (patch.appliesTo === "channel") {
				const target = current.find(label => label.id === id)
				if (target && target.appliesTo !== "channel" && activeChannelCount(current) >= MAX_CHANNEL_LABELS) {
					return current
				}
			}
			return current.map(label => (label.id === id ? { ...label, ...patch, id: label.id } : label))
		})

	const removeDraft = (id: number) =>
		setDraft(current => current.map(label => (label.id === id ? { ...label, retired: true } : label)))

	const addDraft = () => {
		const id = nextLabelId(draft)
		setDraft(current => [
			...current,
			{ id, name: "new label", category: "custom", description: "", color: "#888888", appliesTo: activeChannelCount(current) >= MAX_CHANNEL_LABELS ? "segment" : "channel", predefined: false, retired: false }
		])
		setLastAddedId(id)
	}

	const resetDraft = () => {
		setDraft(DEFAULT_ANNOTATION_LABELS.map(label => ({ ...label })))
		setLastAddedId(null)
	}

	const save = () => {
		if (onSave) onSave(draft)
		else setAnnotationLabels(draft)
		onClose()
	}

		const renderRow = (label: AnnotationLabel) => {
			const windowOptionLocked = atChannelCap && label.appliesTo !== "channel"
			return (
			<div
				key={label.id}
				ref={label.id === lastAddedId ? newRowRef : undefined}
				className="flex flex-col gap-2 rounded-xl border border-background-accent bg-background-accent-light p-2.5 dark:bg-background-accent-dark"
			>
				<div className="flex items-end gap-2">
					<div className="flex flex-col gap-1">
						<span className={fieldLabelClasses}>Color</span>
						<input
							type="color"
							value={label.color}
							onChange={event => updateDraft(label.id, { color: event.target.value })}
							className="h-[1.875rem] w-8 shrink-0 cursor-pointer rounded border border-background-accent bg-transparent p-0"
							aria-label={`Color for ${label.name || "label"}`}
							title="Pick label color"
						/>
					</div>
					<label className="flex flex-1 flex-col gap-1">
						<span className={fieldLabelClasses}>Label</span>
						<input
							ref={label.id === lastAddedId ? newNameInputRef : undefined}
							type="text"
							value={label.name}
							onChange={event => updateDraft(label.id, { name: event.target.value })}
							placeholder="Label name"
							className={`font-medium ${fieldClasses}`}
						/>
					</label>
					<div className="relative flex flex-col gap-1">
						<span className={fieldLabelClasses}>Applies to</span>
						<button
							type="button"
							onClick={() => setOpenPickerFor(current => (current === label.id ? null : label.id))}
							className={`${fieldClasses} flex items-center justify-between gap-2`}
							aria-haspopup="listbox"
							aria-expanded={openPickerFor === label.id}
							title="What this label can be attached to"
						>
							<span className="text-xs">{APPLIES_TO_OPTIONS.find(option => option.value === label.appliesTo)?.label}</span>
							<span aria-hidden className="text-xs leading-none">▾</span>
						</button>
						{openPickerFor === label.id && (
							<>
								<div
									className="fixed inset-0 z-20"
									onClick={() => {
										setOpenPickerFor(null)
										setCapNote(null)
									}}
									role="presentation"
								/>
								<div
									role="listbox"
									className="absolute right-0 top-full z-30 mt-1 min-w-full overflow-hidden rounded-md border border-background-accent bg-background py-0.5 shadow-xl"
								>
									{APPLIES_TO_OPTIONS.map(option => {
										const locked = option.value === "channel" && windowOptionLocked
										return (
											<button
												key={option.value}
												type="button"
												role="option"
												aria-selected={label.appliesTo === option.value}
												aria-disabled={locked}
												onMouseMove={locked ? event => setCapNote({ x: event.clientX, y: event.clientY }) : undefined}
												onMouseLeave={locked ? () => setCapNote(null) : undefined}
												onClick={() => {
													if (locked) return
													updateDraft(label.id, { appliesTo: option.value })
													setOpenPickerFor(null)
													setCapNote(null)
												}}
												className={`block w-full px-2 py-1 text-left text-xs ${
													locked
														? "cursor-not-allowed text-over-background-low opacity-40"
														: "text-over-background-highest hover:bg-background-accent"
												}`}
											>
												{option.label}
											</button>
										)
									})}
								</div>
							</>
						)}
					</div>
					<button
						type="button"
						onClick={() => removeDraft(label.id)}
						className="h-[1.875rem] shrink-0 rounded-md border border-background-accent px-2 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
						aria-label={`Delete ${label.name || "label"}`}
						title="Delete label"
					>
						✕
					</button>
				</div>
				<div className="flex flex-wrap items-end gap-2">
					<label className="flex w-28 flex-col gap-1">
						<span className={fieldLabelClasses}>Category</span>
						<input
							type="text"
							value={label.category}
							onChange={event => updateDraft(label.id, { category: event.target.value })}
							placeholder="Category"
							className={fieldClasses}
						/>
					</label>
					<label className="flex flex-1 flex-col gap-1">
						<span className={fieldLabelClasses}>Description</span>
						<input
							type="text"
							value={label.description}
							onChange={event => updateDraft(label.id, { description: event.target.value })}
							placeholder="Description"
							className={fieldClasses}
						/>
					</label>
				</div>
			</div>
			)
		}

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
			onClick={onClose}
			role="presentation"
		>
			<div
				className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-background p-5 text-over-background-highest shadow-2xl"
				onClick={event => event.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby="annotation-labels-editor-title"
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-low">Annotations</p>
						<div className="mt-1 flex items-center gap-2">
							<h2 id="annotation-labels-editor-title" className="text-base font-semibold">
								Edit annotation labels
							</h2>
							<HelpHint label="What goes in each field?" width="w-[28rem]">
								<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-low">What goes in each field</p>
								<dl className="mt-2 flex flex-col gap-2">
									{FIELD_GUIDE.map(entry => (
										<div key={entry.field} className="grid grid-cols-[5.5rem_1fr] gap-2 text-xs">
											<dt className="text-xs font-semibold text-over-background-highest">{entry.field}</dt>
											<dd className="text-xs text-over-background-medium">
												{entry.help} <span className="text-xs italic text-over-background-low">{entry.example}</span>
											</dd>
										</div>
									))}
								</dl>
							</HelpHint>
						</div>
					</div>
					<button
						type="button"
						onClick={resetDraft}
						className="rounded-md border border-background-accent px-3 py-1 text-xs text-over-background-medium transition-colors hover:text-over-background-highest"
						title="Restore the default label set"
					>
						Reset to defaults
					</button>
				</div>

				<div ref={listRef} className="table-scroll mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
					{SECTIONS.map(section => {
						const rows = visible.filter(label => label.appliesTo === section.value)
						return (
							<section key={section.value} className="flex flex-col gap-2">
								<div className="sticky top-0 z-10 -mx-0.5 flex items-baseline justify-between gap-2 bg-background px-0.5 py-1">
									<h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-over-background-low">{section.title}</h3>
									<span className="text-[10px] text-over-background-low">
										{section.value === "channel" ? `${channelCount}/${MAX_CHANNEL_LABELS} · keys 1-9` : `${rows.length}`}
									</span>
								</div>
								{rows.length === 0 ? (
									<p className="rounded-xl border border-dashed border-background-accent p-3 text-xs text-over-background-medium">{section.empty}</p>
								) : (
									rows.map(renderRow)
								)}
							</section>
						)
					})}
				</div>

				<div className="mt-4 flex items-center justify-between gap-2 border-t border-background-accent pt-4">
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={addDraft}
							title={atChannelCap ? "Window labels are full — the new label will be a segment label" : undefined}
							className="rounded-md border border-background-accent px-3 py-1.5 text-xs font-medium text-over-background-highest transition-colors hover:border-primary hover:text-primary"
						>
							+ Add label
						</button>
						<span className="text-[10px] text-over-background-low">
							{channelCount}/{MAX_CHANNEL_LABELS} window labels (keys 1–9)
						</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded-md border border-background-accent px-3 py-1.5 text-xs text-over-background-medium transition-colors hover:text-over-background-highest"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={save}
							className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-95"
						>
							Save
						</button>
					</div>
				</div>
			</div>

			{capNote && (
				<div
					className="pointer-events-none fixed z-[60] w-max max-w-[15rem] rounded-md border border-background-accent bg-background px-2 py-1 text-[11px] text-over-background-highest shadow-lg"
					style={{ left: capNote.x + 12, top: capNote.y + 18 }}
				>
					{MAX_CHANNEL_LABELS}/{MAX_CHANNEL_LABELS} window labels taken - remove or edit one to free a slot
				</div>
			)}
		</div>,
		document.body
	)
}

export default AnnotationLabelsEditor
