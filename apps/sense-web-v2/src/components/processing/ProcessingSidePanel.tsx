import { useState } from "react"

type SidePanelTab = "analysis" | "annotations"

const TABS: { id: SidePanelTab; label: string }[] = [
	{ id: "analysis", label: "Analysis" },
	{ id: "annotations", label: "Annotations" }
]

/**
 * Right-hand panel beside the session charts. For now it only renders the
 * vertical separator and the "Analysis" / "Annotations" tab titles; the tab
 * bodies are placeholders to be filled in later.
 */
const ProcessingSidePanel: React.FC = () => {
	const [activeTab, setActiveTab] = useState<SidePanelTab>("analysis")

	return (
		<div className="flex h-full flex-col gap-4 border-l border-background-accent pl-4">
			<div className="flex items-center gap-4">
				{TABS.map(tab => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setActiveTab(tab.id)}
						className={`pb-1 text-sm uppercase tracking-[0.18em] transition-colors ${
							activeTab === tab.id
								? "border-b-2 border-primary font-semibold text-over-background-highest"
								: "text-over-background-medium hover:text-over-background-highest"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>
		</div>
	)
}

export default ProcessingSidePanel
