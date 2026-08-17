import { useEffect } from "react"
import { createPortal } from "react-dom"

interface ProcessingHelpOverlayProps {
	open: boolean
	onClose: () => void
}

const STEPS: { title: string; body: string; keys?: string[] }[] = [
	{
		title: "1 · Import a session",
		body: "Pick a finalized acquisition folder. The header then shows how many channels the recording has, how long it lasts and how many segments it is split into."
	},
	{
		title: "2 · Move around the signal",
		body: "Set the window size in seconds, drag the middle of the minimap under the graph to slide the window along the recording, drag its edges to make the window longer or shorter, or use ‹ Prev / Next › to jump one window at a time."
	},
	{
		title: "3 · Run the analysis",
		body: "In the Analysis tab, map each channel to a signal type, then run it over the visible window or over the whole session. When it finishes, the results open in the Results tab of the same panel, they are shown in the app, not only written to disk.",
		keys: ["Analysis ▸ Settings", "Analysis ▸ Results"]
	},
	{
		title: "4 · Annotate",
		body: "Switch Annotations on, choose Point or Interval, pick a label, then click the graph (twice for an interval). Select an annotation to add a note; drag its middle to move it and its edges to resize it.",
		keys: ["P = point", "I = interval", "1-9 = label", "Esc = cancel", "Del = delete"]
	},
	{
		title: "5 · Label a whole segment",
		body: "Segments are the chunks created when you pause and resume an acquisition. Click a segment chip at the top of the page to select it, then click the arrow on it to assign a label to the whole segment."
	},
	{
		title: "6 · Export",
		body: "The Export tab writes raw CSV, a zip of CSV plus annotations, or a PDF report. The PDF already includes the saved analysis when one exists, you do not have to run the analysis again first."
	}
]

/**
 * Quick-start overlay for the processing screen, opened from the "?" button and
 * shown once automatically on the first visit.
 */
const ProcessingHelpOverlay: React.FC<ProcessingHelpOverlayProps> = ({ open, onClose }) => {
	useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose()
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [open, onClose])

	if (!open || typeof document === "undefined") return null

	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4 py-6"
			onClick={onClose}
			role="presentation"
		>
			<div
				className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-background p-5 text-over-background-highest shadow-2xl"
				onClick={event => event.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby="processing-help-title"
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-low">Quick start</p>
						<h2 id="processing-help-title" className="mt-1 text-base font-semibold">
							Analysis and Annotation
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md border border-background-accent px-3 py-1 text-xs text-over-background-medium transition-colors hover:text-over-background-highest"
					>
						Close
					</button>
				</div>

				<div className="table-scroll mt-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
					{STEPS.map(step => (
						<section
							key={step.title}
							className="rounded-xl border border-background-accent bg-background-accent/40 p-3 dark:bg-background-accent-dark/40"
						>
							<h3 className="text-xs font-semibold text-over-background-highest">{step.title}</h3>
							<p className="mt-1 text-xs text-over-background-medium">{step.body}</p>
							{step.keys && (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{step.keys.map(key => (
										<kbd
											key={key}
											className="inline-flex items-center rounded border border-background-accent px-1.5 py-0.5 text-[10px] font-semibold text-over-background-medium"
										>
											{key}
										</kbd>
									))}
								</div>
							)}
						</section>
					))}
				</div>

				<div className="mt-4 flex justify-end border-t border-background-accent pt-4">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-95"
					>
						Got it
					</button>
				</div>
			</div>
		</div>,
		document.body
	)
}

export default ProcessingHelpOverlay
