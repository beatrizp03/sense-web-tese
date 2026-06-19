import { useMemo, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import { useSessionExport } from "../../hooks/useSessionExport"
import { Annotation } from "../../hooks/useAnnotations"
import { AnnotationLabel } from "../../utils/annotationLabels"
import PdfExportModal, { PdfExportRange } from "./PdfExportModal"

interface SessionExportBarProps {
	manifest: any
	withDescriptions?: boolean
	annotations?: Annotation[]
	labels?: AnnotationLabel[]
	defaultSegment?: number
	defaultRange?: { startSec: number; endSec: number } | null
}

/**
 * Export controls: raw CSV and a PDF preview (shared with the acquisition summary
 * page), plus a CSV-with-annotations export.
 */
const SessionExportBar: React.FC<SessionExportBarProps> = ({
	manifest,
	withDescriptions = false,
	annotations = [],
	labels = [],
	defaultSegment = 1,
	defaultRange = null
}) => {
	const { csvDownloading, annotationsDownloading, annotatedPdfDownloading, convertToCSV, convertToCSVWithAnnotations, convertToAnnotatedPDF } = useSessionExport(manifest)
	const hasSession = Array.isArray(manifest?.chunks) && manifest.chunks.length > 0

	const [pdfModalOpen, setPdfModalOpen] = useState(false)

	const channels = useMemo<string[]>(
		() => (Array.isArray(manifest?.channels) ? manifest.channels.map(String) : []),
		[manifest]
	)
	const channelNames = (manifest?.channelNames && typeof manifest.channelNames === "object")
		? (manifest.channelNames as Record<string, string>)
		: {}
	const segmentSeconds = useMemo<number[]>(() => {
		const segs = Array.isArray(manifest?.segments) ? manifest.segments : []
		return segs.map((s: any) => {
			const d = (Number(s?.endedAt) - Number(s?.startedAt)) / 1000
			return Number.isFinite(d) && d > 0 ? d : 0
		})
	}, [manifest])

	const annotationsForDefaultSegment = annotations.filter(
		a => (Number(a.segment) || 1) === defaultSegment
	).length

	const handleGenerate = async (range: PdfExportRange) => {
		await convertToAnnotatedPDF({ ...range, channels, channelNames, annotations, labels })
		setPdfModalOpen(false)
	}

	const options = [
		{
			id: "csv",
			label: csvDownloading ? "Downloading..." : "Download as CSV",
			description: "Raw signal samples for the whole acquired session. Depending on the session length, this file may be very large and take a while to download.",
			onClick: convertToCSV,
			disabled: !hasSession || csvDownloading
		},
		{
			id: "csv-annotations",
			label: annotationsDownloading ? "Downloading..." : "Download as CSV with Annotations",
			description: "The raw signal samples with an extra annotation column, where each annotation is aligned to the frame it was placed on. One CSV per segment, bundled in a zip.",
			onClick: () => convertToCSVWithAnnotations(annotations, labels),
			disabled: !hasSession || annotationsDownloading
		},
		{
			id: "pdf",
			label: annotatedPdfDownloading ? "Generating…" : "Download as PDF",
			description: "Pick a time span to render: the branded report draws each channel with its annotations overlaid, followed by a table of the annotations and their descriptions.",
			onClick: () => setPdfModalOpen(true),
			disabled: !hasSession || annotatedPdfDownloading
		}
	]

	const buttonClass = "text-xs flex-grow motion-safe:hover:!scale-95 motion-safe:active:!scale-95"

	return (
		<div className="space-y-6">
			{withDescriptions ? (
				<div className="space-y-6 rounded-xl border border-background-accent bg-background-accent p-4">
					{options.map(option => (
						<div key={option.id} className="space-y-1">
							<TextButton
								size="base"
								className="text-sm w-full motion-safe:hover:!scale-95 motion-safe:active:!scale-95"
								disabled={option.disabled}
								onClick={option.onClick}
							>
								{option.label}
							</TextButton>
							<p className="text-xs text-over-background-medium">{option.description}</p>
						</div>
					))}
				</div>
			) : (
				<div className="flex flex-wrap gap-6 rounded-xl border border-background-accent bg-background-accent p-4">
					{options.map(option => (
						<TextButton
							key={option.id}
							size="base"
							className={buttonClass}
							disabled={option.disabled}
							onClick={option.onClick}
						>
							{option.label}
						</TextButton>
					))}
				</div>
			)}

			<PdfExportModal
				open={pdfModalOpen}
				onClose={() => setPdfModalOpen(false)}
				segmentSeconds={segmentSeconds}
				defaultSegment={defaultSegment}
				defaultRange={defaultRange}
				annotationCount={annotationsForDefaultSegment}
				generating={annotatedPdfDownloading}
				onGenerate={handleGenerate}
			/>
		</div>
	)
}

export default SessionExportBar
