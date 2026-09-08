import { useEffect, useMemo, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import { collectAnalysisFeatures, findAnalysisResult, useSessionExport } from "../../hooks/useSessionExport"
import { Annotation } from "../../hooks/useAnnotations"
import { AnnotationLabel } from "../../utils/annotationLabels"
import PdfExportModal, { AnalysisFeatureOption, PdfExportRange } from "./PdfExportModal"
import LoadingDots, { LOADING_BUTTON_CLASS } from "./LoadingDots"

interface SessionExportBarProps {
	manifest: any
	withDescriptions?: boolean
	sessionFolder?: string
	annotations?: Annotation[]
	labels?: AnnotationLabel[]
	defaultSegment?: number
	defaultRange?: { startSec: number; endSec: number } | null
	onBusyChange?: (busy: boolean) => void
	/** Per-chunk frame counts from the chart's overview, so the PDF can seek. */
	chunkLengths?: { file: string; frames: number }[] | null
}

/**
 * Export controls: raw CSV and a PDF preview (shared with the acquisition summary
 * page), plus a CSV-with-annotations export.
 */
const SessionExportBar: React.FC<SessionExportBarProps> = ({
	manifest,
	withDescriptions = false,
	sessionFolder = "",
	annotations = [],
	labels = [],
	defaultSegment = 1,
	defaultRange = null,
	onBusyChange,
	chunkLengths = null
}) => {
	const { csvDownloading, annotationsDownloading, annotatedPdfDownloading, convertToCSV, convertToCSVWithAnnotations, convertToAnnotatedPDF } = useSessionExport(manifest, sessionFolder)
	const [featureOptions, setFeatureOptions] = useState<AnalysisFeatureOption[]>([])
	const [featureSource, setFeatureSource] = useState<string>("")
	const [featuresLoading, setFeaturesLoading] = useState(false)
	const hasSession = Array.isArray(manifest?.chunks) && manifest.chunks.length > 0

	const exporting = csvDownloading || annotationsDownloading || annotatedPdfDownloading
	useEffect(() => {
		onBusyChange?.(exporting)
		return () => onBusyChange?.(false)
	}, [exporting, onBusyChange])

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

	useEffect(() => {
		if (!pdfModalOpen) return
		let cancelled = false
		const range = defaultRange
		const startSec = range ? Math.max(0, range.startSec) : 0
		const endSec = range ? range.endSec : segmentSeconds[defaultSegment - 1] || 0
		setFeaturesLoading(true)
		void (async () => {
			const found = await findAnalysisResult(sessionFolder, defaultSegment, startSec, endSec)
			if (cancelled) return
			const rows = found ? collectAnalysisFeatures(found.result, defaultSegment) : []
			const byFeature = new Map<string, AnalysisFeatureOption>()
			for (const row of rows) {
				const existing = byFeature.get(row.feature)
				if (existing) existing.channelCount += 1
				else byFeature.set(row.feature, { feature: row.feature, library: row.library, channelCount: 1 })
			}
			setFeatureOptions([...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature)))
			setFeatureSource(found?.origin ?? "")
			setFeaturesLoading(false)
		})()
		return () => {
			cancelled = true
		}
	}, [pdfModalOpen, sessionFolder, defaultSegment, defaultRange, segmentSeconds])

	const handleGenerate = async (range: PdfExportRange) => {
		await convertToAnnotatedPDF({ ...range, sessionFolder, channels, channelNames, annotations, labels, chunkLengths })
		setPdfModalOpen(false)
	}

	const options = [
		{
			id: "csv",
			label: csvDownloading ? "Downloading CSV" : "Download as CSV",
			description: "Raw signal samples for the whole acquired session. Depending on the session length, this file may be very large and take a while to download.",
			onClick: convertToCSV,
			disabled: !hasSession || csvDownloading,
			loading: csvDownloading
		},
		{
			id: "csv-annotations",
			label: annotationsDownloading ? "Downloading CSV w/ Annotations" : "Download as CSV w/ Annotations",
			description: "A zip with the raw signal (one CSV per segment) plus a separate annotations.csv listing each annotation as NSeq, label, ti, tf, matchable to the raw rows by NSeq.",
			onClick: () => convertToCSVWithAnnotations(annotations, labels),
			disabled: !hasSession || annotationsDownloading,
			loading: annotationsDownloading
		},
		{
			id: "pdf",
			label: annotatedPdfDownloading ? "Downloading PDF" : "Download as PDF",
			description: "A report for the part of the recording you choose. Each channel is drawn with its annotations on top, followed by a table listing them, and a summary of the analysis is added automatically, you do not need to run the analysis first.",
			onClick: () => setPdfModalOpen(true),
			disabled: !hasSession || annotatedPdfDownloading,
			loading: annotatedPdfDownloading
		}
	]

	const loadingClass = LOADING_BUTTON_CLASS
	const buttonClass = "text-xs flex-grow motion-safe:hover:!scale-95 motion-safe:active:!scale-95"

	return (
		<div className="space-y-6">
			{withDescriptions ? (
				<div className="space-y-6 rounded-xl border border-background-accent bg-background-accent p-4">
					{options.map(option => (
						<div key={option.id} className="space-y-1">
							<TextButton
								size="base"
								className={`text-sm w-full motion-safe:hover:!scale-95 motion-safe:active:!scale-95${option.loading ? ` ${loadingClass}` : ""}`}
								disabled={option.disabled}
								onClick={option.onClick}
							>
								<span className="text-sm inline-flex items-center justify-center gap-2">
									{option.loading && <LoadingDots />}
									{option.label}
								</span>
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
							className={`${buttonClass}${option.loading ? ` ${loadingClass}` : ""}`}
							disabled={option.disabled}
							onClick={option.onClick}
						>
							<span className="text-sm inline-flex items-center justify-center gap-2">
								{option.loading && <LoadingDots />}
								{option.label}
							</span>
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
				analysisFeatureOptions={featureOptions}
				analysisFeatureSource={featureSource}
				analysisFeaturesLoading={featuresLoading}
			/>
		</div>
	)
}

export default SessionExportBar
