import { ReactNode, useEffect, useState } from "react"

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
	onActiveTabChange?: (tab: SidePanelTab) => void
	onBeforeTabChange?: (from: SidePanelTab, to: SidePanelTab) => boolean
}

/**
 * Right-hand panel beside the session charts: a vertical separator, the
 * "Analysis" / "Annotations" / "Export" tab titles, and the active tab's body.
 */
const ProcessingSidePanel: React.FC<ProcessingSidePanelProps> = ({
	analysisContent,
	annotationsContent,
	exportContent,
	onActiveTabChange,
	onBeforeTabChange
}) => {
	const [activeTab, setActiveTab] = useState<SidePanelTab>("analysis")

	useEffect(() => {
		onActiveTabChange?.(activeTab)
	}, [activeTab, onActiveTabChange])

	const handleTabClick = (tab: SidePanelTab) => {
		if (tab === activeTab) return
		if (onBeforeTabChange && !onBeforeTabChange(activeTab, tab)) return
		setActiveTab(tab)
	}

	return (
		<div className="flex h-full flex-col gap-4 border-l border-background-accent pl-4">
			<div className="flex items-center justify-between gap-2">
				{TABS.map(tab => {
					const isActive = activeTab === tab.id
					const showLiveDot = tab.id === "annotations" && isActive
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
							{showLiveDot && (
								<span className="relative inline-flex h-2 w-2">
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-over-background-highest opacity-75" />
									<span className="relative inline-flex h-2 w-2 rounded-full bg-over-background-highest" />
								</span>
							)}
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
