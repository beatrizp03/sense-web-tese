import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import SenseLayout from "../components/layout/SenseLayout"
import { AnalysisProgressPanel } from "../components/analysis/AnalysisProgressPanel"

type AnalysisTab = "import" | "results"

const SIGNAL_TYPE_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "ECG", value: "ecg" },
	{ label: "EDA", value: "eda" },
	{ label: "PPG", value: "ppg" },
	{ label: "EMG", value: "emg" },
	{ label: "RSP", value: "rsp" },
	{ label: "EOG", value: "eog" },
	{ label: "EEG", value: "eeg" },
	{ label: "PCG", value: "pcg" },
	{ label: "ACC", value: "acc" }
]

function toRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, kind]) => typeof kind === "string" && kind.length > 0
		)
	) as Record<string, string>
}

function formatNumber(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "--"
	return value.toFixed(2)
}

const Page = () => {
	const [activeTab, setActiveTab] = useState<AnalysisTab>("import")
	const [sessionFolder, setSessionFolder] = useState("")
	const [manifest, setManifest] = useState<any>(null)
	const [analysisResult, setAnalysisResult] = useState<any>(null)
	const [signalKinds, setSignalKinds] = useState<Record<string, string>>({})
	const [loading, setLoading] = useState(false)
	const [status, setStatus] = useState("Import a finalized session folder to begin.")
	const [error, setError] = useState("")
	const [showProgressPanel, setShowProgressPanel] = useState(false)
	const [analysisStartTime, setAnalysisStartTime] = useState<number | null>(null)
	const [showReAnalysisDialog, setShowReAnalysisDialog] = useState(false)
	const analysisInProgressRef = useRef(false)

	const channels = useMemo(() => {
		return Array.isArray(manifest?.channels) ? manifest.channels.map(String) : []
	}, [manifest])

	const channelNames = useMemo(() => {
		return manifest && typeof manifest.channelNames === "object" && manifest.channelNames !== null
			? (manifest.channelNames as Record<string, string>)
			: {}
	}, [manifest])

	const appliedSignalKinds = useMemo(() => {
		const existing = toRecord(manifest?.analysis?.signalKinds ?? manifest?.channelSignalKinds)
		return channels.reduce((acc: Record<string, string>, channel) => {
			const selected = signalKinds[channel] ?? existing[channel] ?? ""
			if (selected) acc[channel] = selected
			return acc
		}, {})
	}, [channels, manifest, signalKinds])

	const loadSessionBundle = useCallback(async (folder: string) => {
		setError("")
		setLoading(true)
		setStatus("Loading session metadata...")
		try {
			const sessionManifest = await window.electronAPI?.readSessionManifest?.(`${folder}/session.json`)
			if (!sessionManifest) {
				throw new Error("The selected folder does not contain a readable session.json file.")
			}

			setSessionFolder(folder)
			setManifest(sessionManifest)
			setSignalKinds(toRecord(sessionManifest.analysis?.signalKinds ?? sessionManifest.channelSignalKinds))

			const existingResult = await window.electronAPI?.readPostHocAnalysisResult?.(folder)
			setAnalysisResult(existingResult || null)
			setStatus(existingResult ? "Loaded session and existing analysis result." : "Loaded session and ready to analyze.")
			setActiveTab("import")
		} catch (loadError) {
			setManifest(null)
			setAnalysisResult(null)
			setSessionFolder("")
			setSignalKinds({})
			setStatus("Import failed.")
			setError(loadError instanceof Error ? loadError.message : String(loadError))
		} finally {
			setLoading(false)
		}
	}, [])

	const importSessionFolder = useCallback(async () => {
		const folder = await window.electronAPI?.selectAnalysisSessionFolder?.()
		if (!folder) return
		await loadSessionBundle(folder)
	}, [loadSessionBundle])

	useEffect(() => {
		if (!window.electronAPI?.onAnalysisProgress) return

		const unsubscribe = window.electronAPI.onAnalysisProgress((data: any) => {
			window.dispatchEvent(
				new CustomEvent("analysis-progress", {
					detail: data,
				})
			)
		})

		return () => {
			if (typeof unsubscribe === "function") unsubscribe()
		}
	}, [])

	const proceedWithAnalysis = useCallback(async () => {
		if (!sessionFolder) {
			setError("Import a session folder first.")
			return
		}

		if (analysisInProgressRef.current) {
			return
		}

		analysisInProgressRef.current = true

		setError("")
		setLoading(true)
		setShowReAnalysisDialog(false)
		setShowProgressPanel(false)
		setAnalysisStartTime(null)

		await new Promise(resolve => setTimeout(resolve, 0))

		const now = Date.now()
		setAnalysisStartTime(now)
		setShowProgressPanel(true)
		setStatus("Running batch analysis over the imported session...")
		try {
			const result = await window.electronAPI?.runPostHocAnalysis?.({
				sessionFolder,
				signalKinds: appliedSignalKinds
			})
			const refreshed = await window.electronAPI?.readPostHocAnalysisResult?.(sessionFolder)
			setAnalysisResult(refreshed || result || null)
			setStatus("Analysis completed and stored in the session folder.")
			setActiveTab("results")
			window.dispatchEvent(
				new CustomEvent("analysis-complete", {
					detail: { resultPath: result?.resultPath }
				})
			)
		} catch (runError) {
			const isCancelled = (runError instanceof Error && runError.message.includes("Cancelled")) ||
				((runError as any)?.cancelled === true)

			if (isCancelled) {
				setStatus("Analysis cancelled.")
				setError("")
			} else {
				setStatus("Analysis failed.")
				setError(runError instanceof Error ? runError.message : String(runError))
			}

			window.dispatchEvent(
				new CustomEvent("analysis-error", {
					detail: {
						message: isCancelled ? "Analysis cancelled." : (runError instanceof Error ? runError.message : String(runError))
					}
				})
			)
		} finally {
			setLoading(false)
			analysisInProgressRef.current = false
		}
	}, [appliedSignalKinds, sessionFolder])

	const runAnalysis = useCallback(() => {
		if (analysisResult) {
			setShowReAnalysisDialog(true)
		} else {
			proceedWithAnalysis()
		}
	}, [analysisResult, proceedWithAnalysis])

	const currentAnalysis = analysisResult ?? manifest?.analysis ?? null
	const segmentCount = Array.isArray(manifest?.segments) ? manifest.segments.length : 0
	const chunkCount = Array.isArray(manifest?.chunks) ? manifest.chunks.length : 0
	const analysisSegmentCount = Array.isArray(currentAnalysis?.segments)
		? currentAnalysis.segments.length
		: 0

	return (
		<SenseLayout
			title="Signal Analysis"
			shortTitle="Analysis"
			returnHref="/"
			className="container flex flex-col items-center justify-start gap-6 py-8"
		>
			<div className="w-full max-w-4xl space-y-6">
				<div className="rounded-xl border border-background-accent bg-background-accent p-6 shadow-sm">
					<div className="flex flex-col gap-4">
						<div className="space-y-0">
							<p className="text-xs uppercase tracking-[0.24em] text-over-background-low">Post-processing</p>
							<h1 className="font-secondary text-3xl text-over-background-highest">Analysis</h1>
							<p className="max-w-2xl text-sm text-over-background-medium">
								Import a session folder, map the channels you want, and run the batch analysis.
							</p>
						</div>
						<div className="flex flex-wrap gap-3">
							<TextButton size="base" onClick={importSessionFolder} disabled={loading}>
								Import Session Folder
							</TextButton>
							<TextButton size="base" onClick={runAnalysis} disabled={loading || !sessionFolder}>
								Run Analysis
							</TextButton>
						</div>
					</div>
				</div>

				<section className="rounded-xl border border-background-accent bg-background-accent p-6 shadow-sm">
					<div className="flex flex-wrap gap-2 border-b border-background-accent pb-4">
						{(["import", "results"] as AnalysisTab[]).map(tab => (
							<button
								key={tab}
								type="button"
								onClick={() => setActiveTab(tab)}
								className={`rounded-full px-4 py-2 text-sm font-medium transition ${activeTab === tab ? "bg-primary text-white" : "bg-background-accent text-over-background-medium"}`}
							>
								{tab === "import" ? "Import" : "Results"}
							</button>
						))}
					</div>

					{activeTab === "import" ? (
						<div className="-mt-3 space-y-0">
							<div className="rounded-xl border border-background-accent bg-background-accent p-4">
								<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
									<div>
										<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Imported session</p>
										<p className="font-medium text-over-background-highest">{sessionFolder || "No session imported yet"}</p>
									</div>
									<div className="text-sm text-over-background-medium">
										{chunkCount > 0 ? `${chunkCount} chunk files` : "Awaiting chunk files"}
									</div>
								</div>
								<div className="mt-3 flex flex-wrap gap-3 text-xs text-over-background-medium">
									<span>Channels: {channels.length || 0}</span>
									<span>Segments: {segmentCount}</span>
								</div>
							</div>

							<div className="space-y-3">
								<p className="text-sm text-over-background-medium">Select only the channels you want to reprocess.</p>
								<div className="space-y-3">
									{channels.length > 0 ? (
										channels.map(channel => {
											const selectedValue = signalKinds[channel] ?? toRecord(manifest?.channelSignalKinds)[channel] ?? ""
											return (
												<div key={channel} className="flex flex-col gap-2 rounded-xl border border-background-accent bg-background-accent-dark p-4 sm:flex-row sm:items-center sm:justify-between dark:bg-background-accent-light">
													<div className="flex items-center justify-between gap-3">
														<div>
															<div className="text-sm font-medium text-over-background-highest-dark dark:text-over-background-highest-light">{channelNames[channel] ?? channel}</div>
															<div className="text-xs text-over-background-low-dark dark:text-over-background-low-light">Channel {channel}</div>
														</div>
														<select
															value={selectedValue}
															onChange={event => {
																const nextValue = event.target.value
																setSignalKinds(current => {
																	const next = { ...current }
																	if (!nextValue) {
																		delete next[channel]
																	} else {
																		next[channel] = nextValue
																	}
																	return next
																})
															}}
															className="min-w-[10rem] rounded-full border border-background-accent bg-background px-3 py-2 text-sm text-over-background-highest outline-none"
														>
															{SIGNAL_TYPE_OPTIONS.map(option => (
																<option key={`${channel}-${option.value || "empty"}`} value={option.value}>
																	{option.label}
																</option>
															))}
														</select>
													</div>
												</div>
										)
										})
									) : (
										<div className="rounded-xl border border-dashed border-background-accent p-6 text-sm text-over-background-medium">
											Import a session folder to load its channels and start analysis.
										</div>
									)}
								</div>
							</div>
						</div>
					) : (
						<div className="-mt-3  space-y-0">
							<div className="rounded-xl border border-background-accent bg-background-accent p-4">
								<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Analysis status</p>
								<p className="mt-2 text-sm text-over-background-highest">{status}</p>
								{error && <p className="mt-2 text-sm text-primary">{error}</p>}
							</div>

							<div className="rounded-xl border border-background-accent bg-background-accent p-4">
								<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Summary</p>
								<div className="mt-3 grid gap-3 text-sm text-over-background-medium sm:grid-cols-3">
									<div>
										<div className="text-over-background-highest">{segmentCount}</div>
										<div>Session segments</div>
									</div>
									<div>
										<div className="text-over-background-highest">{analysisSegmentCount}</div>
										<div>Analyzed segments</div>
									</div>
									<div>
										<div className="text-over-background-highest">{Object.keys(appliedSignalKinds).length}</div>
										<div>Mapped channels</div>
									</div>
								</div>
								{!currentAnalysis && (
									<p className="mt-4 text-sm text-over-background-medium">
										Import a session and run analysis to see the stored result here.
									</p>
								)}
							</div>
						</div>
					)}
				</section>
			</div>

			<AnalysisProgressPanel
				key={analysisStartTime}
				isVisible={showProgressPanel}
				onCancel={() => {
					setShowProgressPanel(false)
					window.electronAPI?.cancelPostHocAnalysis?.()
				}}
				resultPath={analysisResult?.resultPath}
			/>

			{showReAnalysisDialog && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="w-full max-w-md rounded-lg border border-background-accent bg-background-accent p-6 shadow-lg">
						<div className="flex items-center gap-3 mb-4">
							<span className="text-2xl">⚠️</span>
							<h2 className="text-xl font-semibold text-over-background-highest">Re-analyse?</h2>
						</div>
						<p className="text-sm text-over-background-medium mb-6">
							The analysis just ended. Do you want to re-analyse with the current channel mappings?
						</p>
						<div className="flex gap-3">
							<button
								onClick={() => setShowReAnalysisDialog(false)}
								className="flex-1 rounded-lg bg-background-accent-dark dark:bg-background-accent-light px-4 py-2 text-sm font-medium text-over-background-highest-dark dark:text-over-background-highest-light hover:opacity-80"
							>
								Cancel
							</button>
							<button
								onClick={proceedWithAnalysis}
								className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
							>
								Re-analyse
							</button>
						</div>
					</div>
				</div>
			)}
		</SenseLayout>
	)
}

export default Page