import { ReactNode, useState } from "react"

type SidePanelTab = "analysis" | "annotations" | "export"

const TABS: { id: SidePanelTab; label: string }[] = [
	{ id: "analysis", label: "Analysis" },
	{ id: "annotations", label: "Annotations" },
	{ id: "export", label: "Export" }
]

interface ProcessingSidePanelProps {
	analysisContent?: ReactNode
	annotationsContent?: ReactNode
	exportContent?: ReactNode
}

/**
 * Right-hand panel beside the session charts: a vertical separator, the
 * "Analysis" / "Annotations" / "Export" tab titles, and the active tab's body.
 */
const ProcessingSidePanel: React.FC<ProcessingSidePanelProps> = ({
	analysisContent,
	annotationsContent,
	exportContent
}) => {
	const [activeTab, setActiveTab] = useState<SidePanelTab>("analysis")

	return (
		<div className="flex h-full flex-col gap-4 border-l border-background-accent pl-4">
			<div className="flex items-center justify-between gap-2">
				{TABS.map(tab => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setActiveTab(tab.id)}
						className={`whitespace-nowrap pb-1 text-xs uppercase tracking-[0.18em] transition-colors ${
							activeTab === tab.id
								? "border-b-2 border-primary font-semibold text-over-background-highest"
								: "text-over-background-medium hover:text-over-background-highest"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{activeTab === "analysis" ? analysisContent : activeTab === "annotations" ? annotationsContent : exportContent}
			</div>
		</div>
	)
}

export default ProcessingSidePanel
