import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import { AnalysisProgressPanel } from "../analysis/AnalysisProgressPanel"
import { SIGNAL_TYPE_OPTIONS, ACC_AXIS_OPTIONS, toRecord, toAxisRecord } from "./analysisShared"

type AnalysisTab = "import" | "results"

type AnalysisRange = { startSec: number; endSec: number }

const OUTLIER_REMOVAL_LIBRARY_SUPPORT = [
	{
		library: "BioSPPy",
		signals: ["ECG"],
		method: "biosppy.signals.ecg.correct_rpeaks",
		note: "Peak correction is only implemented for ECG in the current worker."
	},
	{
		library: "NeuroKit2",
		signals: ["ECG", "EDA", "PPG", "RSP", "EOG"],
		method: "nk.signal_fixpeaks",
		note: "Uses peak metadata from the processed signal to correct detected peaks."
	},
	{
		library: "Not available",
		signals: ["ACC", "PCG", "EEG"],
		method: "--",
		note: "No outlier-removal step is implemented for these signals in this worker."
	}
] as const

function formatNumber(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "--"
	return value.toFixed(2)
}

function formatLibraryName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "--"
	if (value === "biosppy") return "BioSPPy"
	if (value === "neurokit2") return "NeuroKit2"
	return value
}

function formatSignalList(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "--"
	return value.map(item => String(item).toUpperCase()).join(", ")
}

function windowFolderName(range: AnalysisRange): string {
	return `analysis-${Math.round(range.startSec)}-${Math.round(range.endSec)}`
}

const ANALYSIS_SETTINGS_STORAGE_KEY = "processing:analysisSettings"

interface AnalysisPanelProps {
	sessionFolder: string
	manifest: any
	channels: string[]
	channelNames: Record<string, string>
	signalKinds: Record<string, string>
	setSignalKinds: React.Dispatch<React.SetStateAction<Record<string, string>>>
	signalAxes: Record<string, string>
	setSignalAxes: React.Dispatch<React.SetStateAction<Record<string, string>>>
	appliedSignalKinds: Record<string, string>
	appliedSignalAxes: Record<string, string>
	/** The chart's currently visible window, used by "Analyse Window". */
	windowRange: AnalysisRange | null
	/** Reports whether an analysis run is in progress so the page can block reloads. */
	onBusyChange?: (busy: boolean) => void
}

/**
 * Owns everything analysis-specific on the processing screen: the run controls,
 * channel→signal-kind mapping, library options, the batch-analysis run handler
 * (full session or just the visible window), and the results view + dialogs.
 */
const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
	sessionFolder,
	manifest,
	channels,
	channelNames,
	signalKinds,
	setSignalKinds,
	signalAxes,
	setSignalAxes,
	appliedSignalKinds,
	appliedSignalAxes,
	windowRange,
	onBusyChange
}) => {
	const [activeTab, setActiveTab] = useState<AnalysisTab>("import")
	const [analysisResult, setAnalysisResult] = useState<any>(null)
	const [loading, setLoading] = useState(false)
	const [status, setStatus] = useState("Import a finalized session folder to begin.")
	const [error, setError] = useState("")
	const [showProgressPanel, setShowProgressPanel] = useState(false)
	const [outlierRemovalEnabled, setOutlierRemovalEnabled] = useState(true)
	const [showOutlierRemovalLegend, setShowOutlierRemovalLegend] = useState(false)
	const [showLibraryPolicyLegend, setShowLibraryPolicyLegend] = useState(false)
	const [edaMethodSelection, setEdaMethodSelection] = useState<"neurokit" | "biosppy" | "auto">("auto")
	const [excludedChannels, setExcludedChannels] = useState<Record<string, boolean>>({})
	const [signalKindLibraries, setSignalKindLibraries] = useState<Record<string, "neurokit" | "biosppy">>({})
	const [analysisStartTime, setAnalysisStartTime] = useState<number | null>(null)
	const [showReAnalysisDialog, setShowReAnalysisDialog] = useState(false)
	const [selectedDetailEntry, setSelectedDetailEntry] = useState<any>(null)
	const [showDetailModal, setShowDetailModal] = useState(false)
	const [hydrated, setHydrated] = useState(false)
	const analysisInProgressRef = useRef(false)
	const pendingRangeRef = useRef<AnalysisRange | null>(null)

	useEffect(() => {
		onBusyChange?.(loading)
	}, [loading, onBusyChange])

	useEffect(() => {
		try {
			const saved = sessionStorage.getItem(ANALYSIS_SETTINGS_STORAGE_KEY)
			if (saved) {
				const parsed = JSON.parse(saved)
				if (parsed.activeTab === "import" || parsed.activeTab === "results") setActiveTab(parsed.activeTab)
				if (typeof parsed.outlierRemovalEnabled === "boolean") setOutlierRemovalEnabled(parsed.outlierRemovalEnabled)
				if (parsed.edaMethodSelection === "auto" || parsed.edaMethodSelection === "neurokit" || parsed.edaMethodSelection === "biosppy") setEdaMethodSelection(parsed.edaMethodSelection)
				if (parsed.excludedChannels && typeof parsed.excludedChannels === "object") setExcludedChannels(parsed.excludedChannels)
				if (parsed.signalKindLibraries && typeof parsed.signalKindLibraries === "object") setSignalKindLibraries(parsed.signalKindLibraries)
			}
		} catch {
			// ignore corrupted storage
		}
		setHydrated(true)
	}, [])

	useEffect(() => {
		if (!hydrated) return
		try {
			sessionStorage.setItem(
				ANALYSIS_SETTINGS_STORAGE_KEY,
				JSON.stringify({ activeTab, outlierRemovalEnabled, edaMethodSelection, excludedChannels, signalKindLibraries })
			)
		} catch {
			// ignore quota / serialization errors
		}
	}, [hydrated, activeTab, outlierRemovalEnabled, edaMethodSelection, excludedChannels, signalKindLibraries])

	// Load any stored analysis result for the imported session from disk.
	useEffect(() => {
		let cancelled = false
		if (!sessionFolder) {
			setAnalysisResult(null)
			return
		}
		void (async () => {
			try {
				const existing = await window.electronAPI?.readPostHocAnalysisResult?.(sessionFolder)
				if (cancelled) return
				setAnalysisResult(existing || null)
				setStatus(existing ? "Loaded session and existing analysis result." : "Loaded session and ready to analyze.")
				setError("")
				setActiveTab("import")
			} catch {
				if (!cancelled) setAnalysisResult(null)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [sessionFolder])

	const appliedExcludedChannels = useMemo(() => {
		return channels.filter(channel => excludedChannels[channel])
	}, [channels, excludedChannels])

	const assignedKinds = useMemo(() => {
		const kinds: string[] = []
		for (const channel of channels) {
			if (excludedChannels[channel]) continue
			const kind = appliedSignalKinds[channel]
			if (kind && !kinds.includes(kind)) kinds.push(kind)
		}
		return kinds
	}, [channels, excludedChannels, appliedSignalKinds])

	const allAssignedKinds = useMemo(() => {
		const kinds: string[] = []
		for (const channel of channels) {
			const kind = appliedSignalKinds[channel]
			if (kind && !kinds.includes(kind)) kinds.push(kind)
		}
		return kinds
	}, [channels, appliedSignalKinds])

	const appliedSignalKindLibraries = useMemo(() => {
		return assignedKinds.reduce((acc: Record<string, "neurokit" | "biosppy">, kind) => {
			const library = signalKindLibraries[kind]
			if (library === "neurokit" || library === "biosppy") acc[kind] = library
			return acc
		}, {})
	}, [assignedKinds, signalKindLibraries])

	const analysisSource = analysisResult ?? manifest?.analysis ?? null
	const analysisPolicy = analysisSource?.analysisPolicy ?? analysisSource?.analysisConfig?.libraryPolicy ?? analysisSource?.worker?.libraryPolicy ?? null

	const summaryRows = useMemo(() => {
		return analysisSource?.segments?.flatMap?.((seg: any) => {
			return (seg?.channels || []).map((ch: any) => ({
				segment: seg.segment,
				channel: ch.channel,
				label: ch.label,
				kind: ch.signalKind,
				summary: ch.summary ?? {},
			}))
		}) ?? []
	}, [analysisSource])

	const getChannelAnalysisMetadata = useCallback((channel: any) => {
		const analysis = channel?.analysis ?? {}
		return {
			preprocessing: channel?.preprocessing ?? analysis?.preprocessing ?? null,
			outlierRemoval: channel?.outlierRemoval ?? analysis?.outlierRemoval ?? null
		}
	}, [])

	useEffect(() => {
		if (!showOutlierRemovalLegend) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setShowOutlierRemovalLegend(false)
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [showOutlierRemovalLegend])

	useEffect(() => {
		if (!showLibraryPolicyLegend) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setShowLibraryPolicyLegend(false)
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [showLibraryPolicyLegend])

	const getOutlierRemovalReason = useCallback((outlierRemoval: any) => {
		if (!outlierRemoval) return ""
		if (typeof outlierRemoval.reason === "string" && outlierRemoval.reason.trim()) {
			return outlierRemoval.reason.trim()
		}
		if (outlierRemoval.biosppy?.reason) return String(outlierRemoval.biosppy.reason)
		if (outlierRemoval.neurokit2?.reason) return String(outlierRemoval.neurokit2.reason)
		return ""
	}, [])

	const getDetailLines = useCallback((row: any) => {
		const lines: string[] = []
		const out = row?.outlierRemoval ?? {}
		const prep = row?.preprocessing ?? {}

		if (prep?.steps?.length) lines.push(`Preprocessing: ${prep.steps.join(", ")}`)
		if (row?.notes) lines.push(`Notes: ${row.notes}`)

		const sanitized = typeof (out?.sanitizedCount ?? out?.finiteValueSanitization?.removedCount ?? prep?.sanitizedCount) === "number"
			? (out?.sanitizedCount ?? out?.finiteValueSanitization?.removedCount ?? prep?.sanitizedCount)
			: 0
		lines.push(`Finite values sanitized: ${sanitized} removed`)

		const shifted = typeof (out?.peakCorrectionShiftedCount ?? out?.correctedPeaks ?? out?.peak_shifted ?? out?.peak_shift_count) === "number"
			? (out?.peakCorrectionShiftedCount ?? out?.correctedPeaks ?? out?.peak_shifted ?? out?.peak_shift_count)
			: 0
		lines.push(`Peak correction: ${shifted} peaks shifted`)

		if (out?.applied) {
			const method = out.method ?? out.biosppy?.method ?? out.neurokit2?.method ?? null
			const input = typeof out.inputPeakCount === "number"
				? out.inputPeakCount
				: typeof out.biosppy?.inputPeakCount === "number"
					? out.biosppy.inputPeakCount
					: typeof out.neurokit2?.inputPeakCount === "number"
					? out.neurokit2.inputPeakCount
					: 0
			const output = typeof out.outputPeakCount === "number"
				? out.outputPeakCount
				: typeof out.biosppy?.outputPeakCount === "number"
					? out.biosppy.outputPeakCount
					: typeof out.neurokit2?.outputPeakCount === "number"
					? out.neurokit2.outputPeakCount
					: 0
			const removed = Math.max(0, input - output)
			lines.push(`Outlier removal${method ? ` (${method})` : ""}: ${removed} peaks removed`)
		} else {
			const reason = getOutlierRemovalReason(out)
			if (reason) lines.push(`Outlier removal not applied: ${reason}`)
		}

		return lines
	}, [getOutlierRemovalReason])

	const formatTableCount = useCallback((value: unknown) => {
		if (typeof value !== "number" || !Number.isFinite(value)) return "--"
		return new Intl.NumberFormat("en-US").format(value)
	}, [])

	const formatTablePercent = useCallback((value: unknown) => {
		if (typeof value !== "number" || !Number.isFinite(value)) return "--"
		if (value === 0) return "0%"
		if (value < 0.01) return "<0.01%"
		return `${value.toFixed(2)}%`
	}, [])

	const segmentAnalysisRows = useMemo(() => {
		return analysisSource?.segments?.flatMap?.((seg: any) => {
			return (seg?.channels || []).map((ch: any) => {
				const metadata = getChannelAnalysisMetadata(ch)
				const outlier = metadata.outlierRemoval
				const preprocessing = metadata.preprocessing
				const method = outlier?.method ?? outlier?.biosppy?.method ?? outlier?.neurokit2?.method ?? null
				const outlierReason = getOutlierRemovalReason(outlier)
				const inputCount = typeof outlier?.inputPeakCount === "number"
					? outlier.inputPeakCount
					: typeof outlier?.biosppy?.inputPeakCount === "number"
						? outlier.biosppy.inputPeakCount
						: typeof outlier?.neurokit2?.inputPeakCount === "number"
							? outlier.neurokit2.inputPeakCount
							: null
				const keptCount = typeof outlier?.outputPeakCount === "number"
					? outlier.outputPeakCount
					: typeof outlier?.biosppy?.outputPeakCount === "number"
						? outlier.biosppy.outputPeakCount
						: typeof outlier?.neurokit2?.outputPeakCount === "number"
							? outlier.neurokit2.outputPeakCount
							: (typeof inputCount === "number" ? inputCount : null)
				const rejectedCount = typeof inputCount === "number" && typeof keptCount === "number"
					? Math.max(0, inputCount - keptCount)
					: null
				const rate = typeof inputCount === "number" && typeof rejectedCount === "number" && inputCount > 0
					? (rejectedCount / inputCount) * 100
					: null
				const notes: string[] = []
				if (preprocessing?.steps?.length) notes.push(preprocessing.steps.join(", "))
				if (outlier?.applied) {
					notes.push(method ? `outlier removal: ${method}` : "outlier removal applied")
				} else if (outlierReason) {
					notes.push(`outlier removal not applied: ${outlierReason}`)
				} else {
					notes.push("outlier removal not applied")
				}

				return {
					segment: seg.segment,
					channel: ch.channel,
					label: ch.label,
					kind: ch.signalKind,
					inputCount,
					keptCount,
					rejectedCount,
					rate,
					notes: notes.join(" • "),
					preprocessing,
					outlierRemoval: outlier
				}
			})
		})?.filter((row: any) => row.preprocessing || row.outlierRemoval) ?? []
	}, [analysisSource, getChannelAnalysisMetadata, getOutlierRemovalReason])

	useEffect(() => {
		if (!window.electronAPI?.onAnalysisProgress) return
		const unsubscribe = window.electronAPI.onAnalysisProgress((data: any) => {
			window.dispatchEvent(new CustomEvent("analysis-progress", { detail: data }))
		})
		return () => {
			if (typeof unsubscribe === "function") unsubscribe()
		}
	}, [])

	const proceedWithAnalysis = useCallback(async (range?: AnalysisRange | null) => {
		if (!sessionFolder) {
			setError("Import a session folder first.")
			return
		}
		if (analysisInProgressRef.current) return

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
		setStatus(range ? "Running analysis over the selected window..." : "Running batch analysis over the imported session...")
		const subdir = range ? windowFolderName(range) : undefined
		try {
			const result = await window.electronAPI?.runPostHocAnalysis?.({
				sessionFolder,
				signalKinds: appliedSignalKinds,
				signalAxes: appliedSignalAxes,
				outlierRemoval: outlierRemovalEnabled,
				edaMethod: edaMethodSelection === "auto" ? undefined : edaMethodSelection,
				excludedChannels: appliedExcludedChannels,
				signalKindLibraries: appliedSignalKindLibraries,
				...(range ? { range: { startSec: range.startSec, endSec: range.endSec }, outputSubdir: subdir } : {}),
			})

			if (result?.cancelled === true) {
				setStatus("Analysis cancelled.")
				setError("")
				window.dispatchEvent(new CustomEvent("analysis-error", { detail: { message: "Analysis cancelled." } }))
				return
			}

			const refreshed = await window.electronAPI?.readPostHocAnalysisResult?.(sessionFolder, subdir)
			setAnalysisResult(refreshed || result || null)
			setStatus(range ? "Window analysis completed and stored in the session folder." : "Analysis completed and stored in the session folder.")
			setActiveTab("results")
			window.dispatchEvent(new CustomEvent("analysis-complete", { detail: { resultPath: result?.resultPath } }))
		} catch (runError) {
			const isCancelled = (runError instanceof Error && runError.message.includes("Cancelled")) || ((runError as any)?.cancelled === true)
			if (isCancelled) {
				setStatus("Analysis cancelled.")
				setError("")
			} else {
				setStatus("Analysis failed.")
				setError(runError instanceof Error ? runError.message : String(runError))
			}
			window.dispatchEvent(
				new CustomEvent("analysis-error", {
					detail: { message: isCancelled ? "Analysis cancelled." : (runError instanceof Error ? runError.message : String(runError)) }
				})
			)
		} finally {
			setLoading(false)
			analysisInProgressRef.current = false
		}
	}, [appliedSignalAxes, appliedSignalKinds, sessionFolder, outlierRemovalEnabled, edaMethodSelection, appliedExcludedChannels, appliedSignalKindLibraries])

	const runAnalysis = useCallback(async (range?: AnalysisRange | null) => {
		pendingRangeRef.current = range ?? null
		const subdir = range ? windowFolderName(range) : undefined
		let existing: any = null
		try {
			existing = await window.electronAPI?.readPostHocAnalysisResult?.(sessionFolder, subdir)
		} catch {
			existing = null
		}
		if (existing) {
			setShowReAnalysisDialog(true)
		} else {
			proceedWithAnalysis(range ?? null)
		}
	}, [proceedWithAnalysis, sessionFolder])

	const currentAnalysis = analysisResult ?? manifest?.analysis ?? null
	const segmentCount = Array.isArray(manifest?.segments) ? manifest.segments.length : 0
	const analysisSegmentCount = Array.isArray(currentAnalysis?.segments) ? currentAnalysis.segments.length : 0

	return (
		<div className="space-y-4 pr-1 text-over-background-highest">
			{/* Settings / Results sub-tabs */}
			<div className="flex items-center justify-center gap-2">
				{(["import", "results"] as AnalysisTab[]).map(tab => (
					<button
						key={tab}
						type="button"
						onClick={() => setActiveTab(tab)}
						className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide transition ${activeTab === tab ? "bg-over-primary-medium-light text-over-background-highest-light" : "bg-background-accent-light text-over-background-medium dark:bg-background-accent-dark"}`}
					>
						{tab === "import" ? "Settings" : "Results"}
					</button>
				))}
			</div>

			{activeTab === "import" ? (
				<div className="space-y-3">
					<TextButton size="base" className="text-sm w-full motion-safe:hover:!scale-95 motion-safe:active:!scale-95" onClick={() => runAnalysis(windowRange ?? undefined)} disabled={loading || !sessionFolder || !windowRange}>
						Analyse Window
					</TextButton>
					<TextButton size="base" className="text-sm w-full motion-safe:hover:!scale-95 motion-safe:active:!scale-95" onClick={() => runAnalysis(undefined)} disabled={loading || !sessionFolder}>
						Analyse Full Session
					</TextButton>

					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={outlierRemovalEnabled} onChange={e => setOutlierRemovalEnabled(e.target.checked)} />
						<span className="text-sm">Enable Outlier Removal</span>
					</label>

					<label className="flex items-center gap-2 text-sm">
						<span className="text-sm">Library used:</span>
						<select
							value={edaMethodSelection}
							onChange={e => setEdaMethodSelection(e.target.value as any)}
							className="rounded-full border border-background-accent bg-background px-3 py-1 text-xs"
						>
							<option value="auto">Auto</option>
							<option value="neurokit">NeuroKit2</option>
							<option value="biosppy">BioSPPy</option>
						</select>
					</label>

					<div className="space-y-2">
						<p className="text-xs text-over-background-medium">Map each channel to a signal type. Uncheck a channel to exclude it from library analysis.</p>
						{channels.length > 0 ? (
							channels.map(channel => {
								const selectedValue = signalKinds[channel] ?? toRecord(manifest?.channelSignalKinds)[channel] ?? ""
								const selectedAxis = signalAxes[channel] ?? toAxisRecord(manifest?.channelSignalAxes)[channel] ?? ""
								const isExcluded = Boolean(excludedChannels[channel])
								return (
									<div key={channel} className={`flex flex-col gap-2 rounded-xl border border-background-accent bg-background-accent-light p-3 dark:bg-background-accent-dark ${isExcluded ? "opacity-60" : ""}`}>
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={!isExcluded}
												onChange={event => {
													const include = event.target.checked
													setExcludedChannels(current => {
														const next = { ...current }
														if (include) delete next[channel]
														else next[channel] = true
														return next
													})
												}}
											/>
											<div>
												<div className="text-xs font-medium">{channelNames[channel] ?? channel}</div>
												<div className="text-xs text-over-background-low">Channel {channel}{isExcluded ? " · raw series only" : ""}</div>
											</div>
										</label>
										<div className="flex flex-wrap items-center gap-2">
											<select
												value={selectedValue}
												onChange={event => {
													const nextValue = event.target.value
													setSignalKinds(current => {
														const next = { ...current }
														if (!nextValue) delete next[channel]
														else next[channel] = nextValue
														return next
													})
													setSignalAxes(current => {
														const next = { ...current }
														if (nextValue === "acc") next[channel] = next[channel] || "x"
														else delete next[channel]
														return next
													})
												}}
												className="min-w-[6rem] flex-1 rounded-full border border-background-accent bg-background px-3 py-2 text-xs outline-none"
											>
												{SIGNAL_TYPE_OPTIONS.map(option => (
													<option key={`${channel}-${option.value || "empty"}`} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
											{selectedValue === "acc" ? (
												<select
													value={selectedAxis}
													onChange={event => {
														const nextAxis = event.target.value
														setSignalAxes(current => ({ ...current, [channel]: nextAxis }))
													}}
													className="min-w-[4.5rem] rounded-full border border-background-accent bg-background px-3 py-2 text-xs outline-none"
												>
													{ACC_AXIS_OPTIONS.map(option => (
														<option key={`${channel}-axis-${option.value || "empty"}`} value={option.value}>
															{option.label}
														</option>
													))}
												</select>
											) : null}
										</div>
									</div>
								)
							})
						) : (
							<div className="rounded-xl border border-dashed border-background-accent p-4 text-xs text-over-background-medium">
								Import a session folder to load its channels and start analysis.
							</div>
						)}
					</div>

					{allAssignedKinds.length > 0 ? (
						<div className="space-y-2">
							<p className="text-xs text-over-background-medium">Override the analysis library per signal type. &quot;Default&quot; follows the global &quot;Library used&quot;.</p>
							{allAssignedKinds.map(kind => {
								const kindActive = assignedKinds.includes(kind)
								return (
									<div key={`lib-${kind}`} className={`flex items-center gap-2 rounded-xl border border-background-accent bg-background-accent-light p-3 dark:bg-background-accent-dark ${kindActive ? "" : "opacity-60"}`}>
										<span className="min-w-[3rem] text-xs font-medium uppercase">{kind}</span>
										<select
											value={signalKindLibraries[kind] ?? ""}
											disabled={!kindActive}
											title={kindActive ? undefined : "All channels of this signal type are excluded from analysis"}
											onChange={event => {
												const nextValue = event.target.value
												setSignalKindLibraries(current => {
													const next = { ...current }
													if (nextValue === "neurokit" || nextValue === "biosppy") next[kind] = nextValue
													else delete next[kind]
													return next
												})
											}}
											className="min-w-[6rem] flex-1 rounded-full border border-background-accent bg-background px-3 py-2 text-xs outline-none disabled:cursor-not-allowed"
										>
											<option value="">Default</option>
											<option value="neurokit">NeuroKit2</option>
											<option value="biosppy">BioSPPy</option>
										</select>
									</div>
								)
							})}
						</div>
					) : null}
				</div>
			) : (
				<div className="space-y-3 text-sm">
					<div className="rounded-xl border border-background-accent bg-background-accent p-3">
						<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Analysis status</p>
						<p className="mt-2 text-xs text-over-background-highest">{status}</p>
						{error && <p className="mt-2 text-xs text-primary">{error}</p>}
					</div>

					<div className="rounded-xl border border-background-accent bg-background-accent p-3">
						<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Summary</p>
						<div className="mt-3 flex flex-col gap-2 text-xs text-over-background-medium">
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs">Session segments</span>
								<span className="text-xs text-over-background-highest">{segmentCount}</span>
							</div>
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs">Analyzed segments</span>
								<span className="text-xs text-over-background-highest">{analysisSegmentCount}</span>
							</div>
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs">Mapped channels</span>
								<span className="text-xs text-over-background-highest">{Object.keys(appliedSignalKinds).length}</span>
							</div>
						</div>
						{!currentAnalysis && (
							<p className="mt-4 text-xs text-over-background-medium">Import a session and run analysis to see the stored result here.</p>
						)}
					</div>

					{currentAnalysis && (
						<>
							<div className="rounded-xl border border-background-accent bg-background-accent p-3">
								<div className="flex items-center gap-2">
									<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Library policy</p>
									<button
										type="button"
										onClick={() => setShowLibraryPolicyLegend(true)}
										className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background-accent text-[11px] font-semibold text-over-background-highest transition-colors hover:bg-background-accent"
										aria-label="Show library policy help"
										title="Show library policy help"
									>
										?
									</button>
								</div>
								<p className="py-2 text-xs text-over-background-highest">{analysisPolicy?.summary || "BioSPPy primary + NeuroKit2 secondary on overlapping signals"}</p>
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between gap-3 rounded-lg border border-background-accent px-1 py-1">
										<div className="text-xs uppercase tracking-[0.15em] text-over-background-low">Primary</div>
										<div className="text-xs font-medium">{formatLibraryName(analysisPolicy?.primaryLibrary ?? "biosppy")}</div>
									</div>
									<div className="flex items-center justify-between gap-3 rounded-lg border border-background-accent px-1 py-1">
										<div className="text-xs uppercase tracking-[0.15em] text-over-background-low">Secondary</div>
										<div className="text-xs font-medium">{formatLibraryName(analysisPolicy?.secondaryLibrary ?? "neurokit2")}</div>
									</div>
								</div>
							</div>

							<div className="rounded-xl border border-background-accent bg-background-accent p-3">
								<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Summary statistics</p>
								<div className="mt-3 overflow-x-auto rounded-lg border border-background-accent">
									<table className="w-full min-w-[640px] border-separate border-spacing-0 text-left text-xs">
										<thead>
											<tr>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Segment</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Channel</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Kind</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Mean</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Median</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Std</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Min</th>
												<th className="border-b border-background-accent px-1 py-1 text-xs">Max</th>
											</tr>
										</thead>
										<tbody>
											{summaryRows.length > 0 ? summaryRows.map((row: any) => (
												<tr key={`${row.segment}-${row.channel}`} className="align-top">
													<td className="border-b border-background-accent px-1 py-1 text-xs">{row.segment ?? "--"}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{row.label || row.channel || "--"}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{row.kind || "--"}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{formatNumber(row.summary?.mean)}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{formatNumber(row.summary?.median)}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{formatNumber(row.summary?.std)}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{formatNumber(row.summary?.min)}</td>
													<td className="border-b border-background-accent px-1 py-1 text-xs">{formatNumber(row.summary?.max)}</td>
											</tr>
											)) : (
												<tr>
													<td className="px-1 py-1 text-over-background-medium text-xs" colSpan={8}>No summary statistics available.</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							</div>

							<div className="rounded-xl border border-background-accent bg-background-accent p-3">
								<div className="flex items-center gap-2">
									<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Outlier Removal &amp; Preprocessing</p>
									<button
										type="button"
										onClick={() => setShowOutlierRemovalLegend(true)}
										className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background-accent text-[11px] font-semibold text-over-background-highest transition-colors hover:bg-background-accent"
										aria-label="Show outlier removal legend"
										title="Show outlier removal legend"
									>
										?
									</button>
								</div>
								{segmentAnalysisRows.length > 0 ? (
									<div className="mt-3 space-y-3 text-sm">
										{(Array.from(new Set(segmentAnalysisRows.map((row: any) => String(row.segment)))) as string[]).map(segmentId => {
											const rows = segmentAnalysisRows.filter((row: any) => String(row.segment) === segmentId)
											return (
												<div key={segmentId} className="rounded-lg border border-background-accent p-0">
													<div className="mb-3 text-xs font-semibold">Segment {segmentId}</div>
													<div className="overflow-x-auto">
														<table className="w-full min-w-[560px] border-separate border-spacing-0 text-left text-xs">
															<thead>
																<tr>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Channel</th>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Kind</th>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Peaks</th>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Kept</th>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Rejected</th>
																	<th className="border-b border-background-accent px-1 py-1 text-xs">Rate</th>
																</tr>
															</thead>
															<tbody>
																{rows.map((entry: any) => {
																	const rowKey = `${entry.segment}-${entry.channel}`
																	const detailLines = getDetailLines(entry)
																	return (
																		<tr key={rowKey} className="align-top">
																			<td className="border-b border-background-accent px-1 py-1 text-xs">{entry.label || entry.channel}</td>
																			<td className="border-b border-background-accent px-1 py-1 text-xs">{entry.kind || "--"}</td>
																			<td className="border-b border-background-accent px-1 py-1 text-xs">{formatTableCount(entry.inputCount)}</td>
																			<td className="border-b border-background-accent px-1 py-1 text-xs">{formatTableCount(entry.keptCount)}</td>
																			<td className="border-b border-background-accent px-1 py-1 text-xs">{formatTableCount(entry.rejectedCount)}</td>
																			<td className="border-b border-background-accent px-1 py-1 text-xs">
																				<div className="flex items-center justify-between gap-2">
																					<div>{formatTablePercent(entry.rate)}</div>
																					{detailLines.length > 0 && (
																						<button
																							type="button"
																							onClick={() => { setSelectedDetailEntry(entry); setShowDetailModal(true) }}
																							className="ml-2 rounded bg-background-accent px-1 py-1 text-xs text-over-background-low hover:opacity-95"
																						>
																							Details
																						</button>
																					)}
																				</div>
																			</td>
																		</tr>
																	)
																})}
															</tbody>
														</table>
													</div>
												</div>
											)
										})}
									</div>
								) : (
									<p className="mt-3 text-xs text-over-background-medium">No preprocessing or outlier removal metadata was recorded for this analysis.</p>
								)}
							</div>
						</>
					)}
				</div>
			)}

			<AnalysisProgressPanel
				key={analysisStartTime}
				isVisible={showProgressPanel}
				startTime={analysisStartTime}
				onRetry={() => proceedWithAnalysis(pendingRangeRef.current)}
				onCancel={() => {
					setShowProgressPanel(false)
					window.electronAPI?.cancelPostHocAnalysis?.()
				}}
				resultPath={analysisResult?.resultPath}
			/>

			{showOutlierRemovalLegend && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
					onClick={() => setShowOutlierRemovalLegend(false)}
					role="presentation"
				>
					<div
						className="w-full max-w-3xl rounded-xl bg-background-accent-dark p-5 shadow-2xl dark:bg-background-accent-light"
						onClick={event => event.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="outlier-removal-legend-title"
					>
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-highest-dark dark:text-over-background-highest-light">Help</p>
								<h2 id="outlier-removal-legend-title" className="mt-1 text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">
									Outlier removal support by library
								</h2>
							</div>
							<button
								type="button"
								onClick={() => setShowOutlierRemovalLegend(false)}
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-95"
								aria-label="Close outlier removal help"
							>
								Close
							</button>
						</div>
						<div className="mt-4 overflow-x-auto text-[11px] text-over-background-medium">
							<table className="w-full min-w-[720px] text-[11px] border-separate border-spacing-0 text-left text-over-background-highest-dark dark:text-over-background-highest-light">
								<thead>
									<tr>
										<th className="px-3 py-2 text-xs">Library</th>
										<th className="px-3 py-2 text-xs">Signals</th>
										<th className="px-3 py-2 text-xs">Method</th>
									</tr>
								</thead>
								<tbody>
									{OUTLIER_REMOVAL_LIBRARY_SUPPORT.map(entry => (
										<tr key={entry.library} className="align-top">
											<td className="px-3 py-2 text-xs text-over-background-medium-dark dark:text-over-background-medium-light">{entry.library}</td>
											<td className="px-3 py-2 text-xs text-over-background-medium-dark dark:text-over-background-medium-light">{entry.signals.join(", ")}</td>
											<td className="px-3 py-2 text-xs text-over-background-medium-dark dark:text-over-background-medium-light">{entry.method}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						<p className="mt-4 text-[11px] text-over-background-medium-dark dark:text-over-background-medium-light">
							Press <span className="font-semibold text-[11px]">Esc</span> or click outside the popup to close it.
						</p>
					</div>
				</div>
			)}

			{showLibraryPolicyLegend && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
					onClick={() => setShowLibraryPolicyLegend(false)}
					role="presentation"
				>
					<div
						className="w-full max-w-3xl rounded-xl bg-background-accent-dark p-5 shadow-2xl dark:bg-background-accent-light"
						onClick={event => event.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="library-policy-legend-title"
					>
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-highest-dark dark:text-over-background-highest-light">Help</p>
								<h2 id="library-policy-legend-title" className="mt-1 text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">
									Library policy summary
								</h2>
							</div>
							<button
								type="button"
								onClick={() => setShowLibraryPolicyLegend(false)}
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-95"
								aria-label="Close library policy help"
							>
								Close
							</button>
						</div>
						<div className="mt-4 space-y-4 text-[11px] text-over-background-medium dark:text-over-background-medium-light">
							<div className="grid gap-2 sm:grid-cols-2">
								<div>BioSPPy primary signals: ECG, EDA, PPG, EMG, RSP, EEG, PCG, ACC</div>
								<div>NeuroKit2 secondary signals: ECG, EDA, PPG, EMG, RSP, EEG</div>
								<div>NeuroKit2-only signals: EOG, HRV</div>
								<div>Stored policy coverage: {formatSignalList(Object.keys(analysisPolicy?.signalPolicies ?? {}))}</div>
							</div>
							<p className="text-[11px] text-over-background-medium-dark dark:text-over-background-medium-light">
								HRV is derived from ECG.
							</p>
						</div>
					</div>
				</div>
			)}

			{showDetailModal && selectedDetailEntry && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
					onClick={() => setShowDetailModal(false)}
					role="presentation"
				>
					<div
						className="w-full max-w-3xl rounded-xl bg-background-accent-dark p-5 shadow-2xl dark:bg-background-accent-light"
						onClick={event => event.stopPropagation()}
						role="dialog"
						aria-modal="true"
					>
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-highest-dark dark:text-over-background-highest-light">Details</p>
								<h2 className="mt-1 text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">
									{selectedDetailEntry.label || selectedDetailEntry.channel} — Segment {selectedDetailEntry.segment}
								</h2>
							</div>
							<button
								type="button"
								onClick={() => setShowDetailModal(false)}
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-95"
								aria-label="Close details"
							>
								Close
							</button>
						</div>
						<div className="mt-4 overflow-x-auto text-[11px] text-over-background-medium-dark dark:text-over-background-medium-light">
							<div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
								<div>
									<div className="text-xs text-over-background-medium-dark dark:text-over-background-medium-light">Peaks in the Session</div>
									<div className="text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">{formatTableCount(selectedDetailEntry.inputCount)}</div>
								</div>
								<div>
									<div className="text-xs text-over-background-medium-dark dark:text-over-background-medium-light">Peaks kept</div>
									<div className="text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">{formatTableCount(selectedDetailEntry.keptCount)}</div>
								</div>
								<div>
									<div className="text-xs text-over-background-medium-dark dark:text-over-background-medium-light">Rejected</div>
									<div className="text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">{formatTableCount(selectedDetailEntry.rejectedCount)}</div>
								</div>
								<div>
									<div className="text-xs text-over-background-medium-dark dark:text-over-background-medium-light">Rate</div>
									<div className="text-base font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">{formatTablePercent(selectedDetailEntry.rate)}</div>
								</div>
							</div>

							{selectedDetailEntry.preprocessing?.steps?.length ? (
								<div className="mb-4">
									<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Preprocessing</div>
									<div className="mt-1 text-xs">{selectedDetailEntry.preprocessing.steps.join(", ")}</div>
								</div>
							) : null}

							<div className="mb-4">
								<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Outlier removal</div>
								<div className="mt-1 text-xs">
									{selectedDetailEntry.outlierRemoval?.applied ? (
										(() => {
											const out = selectedDetailEntry.outlierRemoval
											const method = out.method ?? out.biosppy?.method ?? out.neurokit2?.method ?? "(unknown)"
											const input = typeof out.inputPeakCount === "number" ? out.inputPeakCount : (typeof out.biosppy?.inputPeakCount === "number" ? out.biosppy.inputPeakCount : (typeof out.neurokit2?.inputPeakCount === "number" ? out.neurokit2.inputPeakCount : 0))
											const output = typeof out.outputPeakCount === "number" ? out.outputPeakCount : (typeof out.biosppy?.outputPeakCount === "number" ? out.biosppy.outputPeakCount : (typeof out.neurokit2?.outputPeakCount === "number" ? out.neurokit2.outputPeakCount : 0))
											const removed = Math.max(0, input - output)
											return (
												<div>
													<div>{`Method: ${method}`}</div>
													<div>{`Input peaks: ${input}`}</div>
													<div>{`Output peaks: ${output}`}</div>
													<div>{`Removed: ${removed}`}</div>
												</div>
											)
										})()
									) : (
										<div>{getOutlierRemovalReason(selectedDetailEntry.outlierRemoval) || "Not applied"}</div>
									)}
								</div>
							</div>

							<div className="mb-4">
								<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Sanitization</div>
								<div className="mt-1 text-xs">Finite values sanitized: {typeof (selectedDetailEntry.outlierRemoval?.sanitizedCount ?? selectedDetailEntry.outlierRemoval?.finiteValueSanitization?.removedCount ?? selectedDetailEntry.preprocessing?.sanitizedCount) === "number" ? (selectedDetailEntry.outlierRemoval?.sanitizedCount ?? selectedDetailEntry.outlierRemoval?.finiteValueSanitization?.removedCount ?? selectedDetailEntry.preprocessing?.sanitizedCount) : 0}</div>
							</div>

							{selectedDetailEntry.notes && (
								<div className="mb-1">
									<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Notes</div>
									<div className="mt-1 text-xs">{selectedDetailEntry.notes}</div>
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{showReAnalysisDialog && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="w-full max-w-md rounded-lg bg-background-light p-6 shadow-lg dark:bg-background-dark">
						<div className="flex items-center gap-3 mb-4">
							<span className="text-2xl">⚠️</span>
							<h2 className="text-xl font-semibold text-over-background-highest-light dark:text-over-background-highest-dark">Re-analyse?</h2>
						</div>
						<p className="text-sm text-over-background-medium-light dark:text-over-background-medium-dark mb-6">
							The analysis just ended. Do you want to re-analyse with the current channel mappings?
						</p>
						<div className="flex gap-3">
							<button
								onClick={() => setShowReAnalysisDialog(false)}
								className="flex-1 rounded-lg border border-over-background-highest-light dark:border-over-background-highest-dark bg-background-accent-light dark:bg-background-accent-dark px-4 py-2 text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark hover:opacity-80"
							>
								Cancel
							</button>
							<button
								onClick={() => proceedWithAnalysis(pendingRangeRef.current)}
								className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
							>
								Re-analyse
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

export default AnalysisPanel
