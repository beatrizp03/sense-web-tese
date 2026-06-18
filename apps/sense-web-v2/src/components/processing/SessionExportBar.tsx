import { TextButton } from "@scientisst/react-ui/components/inputs"

import { useSessionExport } from "../../hooks/useSessionExport"

interface SessionExportBarProps {
	manifest: any
	withDescriptions?: boolean
	onExportAnnotations?: () => void
}

/**
 * Export controls: raw CSV and a PDF preview (shared with the acquisition summary
 * page), plus a CSV-with-annotations export.
 */
const SessionExportBar: React.FC<SessionExportBarProps> = ({ manifest, withDescriptions = false, onExportAnnotations }) => {
	const { csvDownloading, convertToCSV, convertToPDF } = useSessionExport(manifest)
	const hasSession = Array.isArray(manifest?.chunks) && manifest.chunks.length > 0

	const options = [
		{
			label: csvDownloading ? "Downloading..." : "Download as CSV",
			description: "Raw signal samples for the whole acquired session. Depending on the session length, this file may be very large and take a while to download.",
			onClick: convertToCSV,
			disabled: !hasSession || csvDownloading
		},
		{
			label: "Download as PDF",
			description: "A printable PDF report with a ten-second preview of each channel.",
			onClick: convertToPDF,
			disabled: !hasSession
		},
		{
			label: "Download CSV + Annotations",
			description: "Your saved annotations and labels, exported as annotations.csv in the session folder.",
			onClick: onExportAnnotations,
			disabled: !hasSession || !onExportAnnotations
		}
	]

	const buttonClass = "text-xs flex-grow motion-safe:hover:!scale-95 motion-safe:active:!scale-95"

	return (
		<div className="space-y-6">
			{withDescriptions ? (
				<div className="space-y-6 rounded-xl border border-background-accent bg-background-accent p-4">
					{options.map(option => (
						<div key={option.label} className="space-y-1">
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
							key={option.label}
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
		</div>
	)
}

export default SessionExportBar
