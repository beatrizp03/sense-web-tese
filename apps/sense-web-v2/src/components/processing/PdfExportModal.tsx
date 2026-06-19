import { useEffect, useMemo, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

export interface PdfExportRange {
	segment: number
	startSec: number
	endSec: number
	includeAnalysis: boolean
}

interface PdfExportModalProps {
	open: boolean
	onClose: () => void
	segmentSeconds: number[]
	defaultSegment?: number
	defaultRange?: { startSec: number; endSec: number } | null
	annotationCount?: number
	generating?: boolean
	onGenerate: (range: PdfExportRange) => void
}

/**
 * Lets the user pick the segment and time span to render in the annotated PDF.
 */
const PdfExportModal: React.FC<PdfExportModalProps> = ({
	open,
	onClose,
	segmentSeconds,
	defaultSegment = 1,
	defaultRange,
	annotationCount = 0,
	generating = false,
	onGenerate
}) => {
	const segmentCount = Math.max(1, segmentSeconds.length)
	const [segment, setSegment] = useState(defaultSegment)
	const [startDraft, setStartDraft] = useState("0")
	const [endDraft, setEndDraft] = useState("30")
	const [includeAnalysis, setIncludeAnalysis] = useState(true)

	const maxSeconds = segmentSeconds[segment - 1] || 0

	useEffect(() => {
		if (!open) return
		const seg = Math.min(Math.max(1, defaultSegment), segmentCount)
		setSegment(seg)
		const segMax = segmentSeconds[seg - 1] || 0
		const start = defaultRange ? Math.max(0, defaultRange.startSec) : 0
		const end = defaultRange ? defaultRange.endSec : segMax > 0 ? Math.min(30, segMax) : 30
		setStartDraft(String(Math.round(start)))
		setEndDraft(String(Math.round(end)))
	}, [open, defaultSegment, defaultRange, segmentCount, segmentSeconds])

	const start = Number(startDraft)
	const end = Number(endDraft)
	const error = useMemo(() => {
		if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter valid numbers."
		if (start < 0) return "Start must be ≥ 0."
		if (end <= start) return "End must be after start."
		if (maxSeconds > 0 && start >= maxSeconds) return "Start is past the end of the segment."
		return null
	}, [start, end, maxSeconds])

	if (!open) return null

	const clampedEnd = maxSeconds > 0 ? Math.min(end, maxSeconds) : end

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
			<div className="w-full max-w-md rounded-xl border border-background-accent bg-background p-6 shadow-2xl">
				<h2 className="text-lg font-bold text-over-background-highest">Export annotated PDF</h2>
				<p className="mt-1 text-xs text-over-background-medium">
					Choose the time span to draw. Annotations inside the span are overlaid on the
					charts and listed in a table.
				</p>

				{segmentCount > 1 && (
					<div className="mt-4">
						<p className="mb-1.5 text-xs uppercase tracking-[0.18em] text-over-background-low">Segment</p>
						<div className="flex flex-wrap gap-1.5">
							{Array.from({ length: segmentCount }, (_, i) => i + 1).map(seg => (
								<button
									key={seg}
									type="button"
									onClick={() => setSegment(seg)}
									className={`rounded-full px-3 py-1 text-xs font-medium transition ${
										seg === segment
											? "bg-primary/15 text-over-background-highest ring-1 ring-primary"
											: "bg-background-accent text-over-background-medium hover:opacity-80"
									}`}
								>
									Segment {seg}
								</button>
							))}
						</div>
					</div>
				)}

				<div className="mt-4 grid grid-cols-2 gap-3">
					<label className="flex flex-col gap-1 text-xs text-over-background-medium">
						Start (s)
						<input
							type="number"
							min={0}
							value={startDraft}
							onChange={e => setStartDraft(e.target.value)}
							className="rounded border border-background-accent bg-background-accent px-2 py-1.5 text-sm tabular-nums text-over-background-highest outline-none focus:border-primary"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-over-background-medium">
						End (s)
						<input
							type="number"
							min={0}
							value={endDraft}
							onChange={e => setEndDraft(e.target.value)}
							className="rounded border border-background-accent bg-background-accent px-2 py-1.5 text-sm tabular-nums text-over-background-highest outline-none focus:border-primary"
						/>
					</label>
				</div>

				<p className="mt-2 text-[11px] text-over-background-low">
					{maxSeconds > 0 ? `Segment length: ${maxSeconds.toFixed(1)} s · ` : ""}
					{annotationCount} annotation{annotationCount === 1 ? "" : "s"} on this segment
				</p>

				<label className="mt-3 flex items-start gap-2 text-xs text-over-background-medium">
					<input
						type="checkbox"
						checked={includeAnalysis}
						onChange={e => setIncludeAnalysis(e.target.checked)}
						className="mt-0.5 h-3.5 w-3.5 accent-primary"
					/>
					<span className="flex flex-col gap-1 text-xs">
						Include analysis summary
						<span className="block text-xs text-over-background-low">
							Uses this window&apos;s saved analysis if available, otherwise the full-session
							analysis. If both unavailable, basic stats are computed from the window.
						</span>
					</span>
				</label>

				{error && <p className="mt-2 text-xs text-red-500">{error}</p>}

				<div className="mt-6 flex justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						disabled={generating}
						className="rounded-lg border border-background-accent px-4 py-2 text-sm text-over-background-medium hover:bg-background-accent disabled:opacity-40"
					>
						Cancel
					</button>
					<TextButton
						size="base"
						className="!text-sm"
						disabled={!!error || generating}
						onClick={() => onGenerate({ segment, startSec: Math.max(0, start), endSec: clampedEnd, includeAnalysis })}
					>
						{generating ? "Generating…" : "Generate PDF"}
					</TextButton>
				</div>
			</div>
		</div>
	)
}

export default PdfExportModal
