import { ReactNode } from "react"

export type SidePanelTab = "analysis" | "annotations" | "export"

const TABS: { id: SidePanelTab; label: string }[] = [
	{ id: "analysis", label: "Analysis" },
	{ id: "annotations", label: "Annotations" },
	{ id: "export", label: "Export" }
]

interface ProcessingSidePanelProps {
	analysisContent?: ReactNode
	annotationsContent?: ReactNode
	exportContent?: ReactNode
	activeTab: SidePanelTab
	/** Request to switch tabs; the parent decides whether to allow it. */
	onTabChange: (tab: SidePanelTab) => void
}

/**
 * Right-hand panel beside the session charts: a vertical separator, the
 * "Analysis" / "Annotations" / "Export" tab titles, and the active tab's body.
 */
const ProcessingSidePanel: React.FC<ProcessingSidePanelProps> = ({
	analysisContent,
	annotationsContent,
	exportContent,
	activeTab,
	onTabChange
}) => {
	const handleTabClick = (tab: SidePanelTab) => {
		if (tab === activeTab) return
		onTabChange(tab)
	}

	return (
		<div className="flex h-full flex-col gap-4 border-l border-background-accent pl-4">
			<div className="flex items-center justify-between gap-2">
				{TABS.map(tab => {
					const isActive = activeTab === tab.id
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => handleTabClick(tab.id)}
							className={`inline-flex items-center gap-1.5 whitespace-nowrap pb-1 text-xs uppercase tracking-[0.18em] transition-colors ${
								isActive
									? "border-b-2 border-primary font-semibold text-over-background-highest"
									: "text-over-background-medium hover:text-over-background-highest"
							}`}
						>
							{tab.label}
						</button>
					)
				})}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{activeTab === "analysis" ? analysisContent : activeTab === "annotations" ? annotationsContent : exportContent}
			</div>
		</div>
	)
}

export default ProcessingSidePanel
