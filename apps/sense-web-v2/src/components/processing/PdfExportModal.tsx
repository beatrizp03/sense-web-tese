import { useEffect, useMemo, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import LoadingDots, { LOADING_BUTTON_CLASS } from "./LoadingDots"
import { Text as ChakraText } from "@chakra-ui/react"

export interface PdfExportRange {
	segment: number
	startSec: number
	endSec: number
	includeAnalysis: boolean
	observations: string
}

/** Accepts "90", "1:30" and "1:02:03"; returns seconds, or null if unreadable. */
function parseTimeInput(raw: string): number | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	if (trimmed.includes(":")) {
		const parts = trimmed.split(":")
		if (parts.length !== 2 && parts.length !== 3) return null
		const nums = parts.map(part => (part.trim() === "" ? NaN : Number(part)))
		if (nums.some(n => !Number.isFinite(n) || n < 0)) return null
		return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
	}
	const seconds = Number(trimmed)
	return Number.isFinite(seconds) ? seconds : null
}

/** Seconds as "m:ss", rolling over to "h:mm:ss" past an hour. */
function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
	const total = Math.round(seconds)
	const s = String(total % 60).padStart(2, "0")
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
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
	title?: string
	description?: string
	showAnnotationInfo?: boolean
	showAnalysisToggle?: boolean
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
	onGenerate,
	title = "Export annotated PDF",
	description = "Choose the part of the recording to put in the report. Annotations inside that span are drawn on the charts and listed in a table underneath them.",
	showAnnotationInfo = true,
	showAnalysisToggle = true
}) => {
	const segmentCount = Math.max(1, segmentSeconds.length)
	const [segment, setSegment] = useState(defaultSegment)
	const [startDraft, setStartDraft] = useState("0")
	const [endDraft, setEndDraft] = useState("30")
	const [includeAnalysis, setIncludeAnalysis] = useState(true)
	const [observations, setObservations] = useState("")

	const maxSeconds = segmentSeconds[segment - 1] || 0

	useEffect(() => {
		if (!open) return
		const seg = Math.min(Math.max(1, defaultSegment), segmentCount)
		setSegment(seg)
		const segMax = segmentSeconds[seg - 1] || 0
		const startSec = defaultRange ? Math.max(0, defaultRange.startSec) : 0
		const endSec = defaultRange ? defaultRange.endSec : segMax > 0 ? Math.min(30, segMax) : 30
		setStartDraft(formatTime(startSec))
		setEndDraft(formatTime(endSec))
	}, [open, defaultSegment, defaultRange, segmentCount, segmentSeconds])

	const start = parseTimeInput(startDraft)
	const end = parseTimeInput(endDraft)
	const error = useMemo(() => {
		if (start === null || end === null) return "Enter each time as m:ss (e.g. 30:01) or as plain seconds."
		if (start < 0) return "Start must be ≥ 0."
		if (end <= start) return "End must be after start."
		if (maxSeconds > 0 && start >= maxSeconds) return "Start is past the end of the segment."
		if (maxSeconds > 0 && end > maxSeconds)
			return `End must be within the acquisition length (${formatTime(maxSeconds)}).`
		return null
	}, [start, end, maxSeconds])

	if (!open) return null

	const startSec = start ?? 0
	const endSec = end ?? 0
	const clampedEnd = maxSeconds > 0 ? Math.min(endSec, maxSeconds) : endSec

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
			<div className="w-full max-w-md rounded-xl border border-background-accent bg-background p-6 shadow-2xl">
				<h2 className="text-lg font-bold text-over-background-highest">{title}</h2>
				<p className="mt-1 text-xs text-over-background-medium">{description}</p>

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
						Start (hh:mm:ss)
						<input
							type="text"
							inputMode="numeric"
							value={startDraft}
							onChange={e => setStartDraft(e.target.value)}
							placeholder="0:00"
							className="rounded border border-background-accent bg-background-accent px-2 py-1.5 text-sm tabular-nums text-over-background-highest outline-none focus:border-primary"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-over-background-medium">
						End (hh:mm:ss)
						<input
							type="text"
							inputMode="numeric"
							value={endDraft}
							onChange={e => setEndDraft(e.target.value)}
							placeholder="0:30"
							className="rounded border border-background-accent bg-background-accent px-2 py-1.5 text-sm tabular-nums text-over-background-highest outline-none focus:border-primary"
						/>
					</label>
				</div>

				<p className="mt-2 text-[11px] text-over-background-low">
					{maxSeconds > 0 ? `Segment length: ${formatTime(maxSeconds)} (${maxSeconds.toFixed(1)} s)` : ""}
					{showAnnotationInfo
						? `${maxSeconds > 0 ? " · " : ""}${annotationCount} annotation${annotationCount === 1 ? "" : "s"} on this segment`
						: ""}
				</p>

				{showAnalysisToggle && (
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
				)}

				<label className="mt-3 flex flex-col gap-1 text-xs text-over-background-medium">
					Observations (optional)
					<textarea
						value={observations}
						onChange={e => setObservations(e.target.value)}
						rows={3}
						placeholder="Notes to print on the report, e.g. recording conditions or anything unusual."
						className="resize-none rounded border border-background-accent bg-background-accent px-2 py-1.5 text-xs text-over-background-highest outline-none focus:border-primary"
					/>
				</label>

				{error && <p className="mt-2 text-xs text-red-500">{error}</p>}

				<div className="mt-6 flex justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						disabled={generating}
						className="rounded-lg border border-background-accent px-4 py-2 text-sm text-over-background-medium hover:bg-background-accent disabled:opacity-5"
					>
						Cancel
					</button>
					<TextButton
						size="base"
						className={`!text-sm${generating ? ` ${LOADING_BUTTON_CLASS}` : ""}`}
						disabled={!!error || generating}
						onClick={() => onGenerate({ segment, startSec: Math.max(0, startSec), endSec: clampedEnd, includeAnalysis, observations })}
					>
						<span className="inline-flex items-center justify-center gap-2">
							{generating && <LoadingDots />}
							{generating ? "Downloading" : "Download PDF"}
						</span>
					</TextButton>
				</div>
			</div>
		</div>
	)
}

export default PdfExportModal
