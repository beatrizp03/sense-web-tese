import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import SenseLayout from "../components/layout/SenseLayout"
import { AnalysisProgressPanel } from "../components/analysis/AnalysisProgressPanel"
import { useBusyGuard } from "../hooks/useBusyGuard"

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

const ACC_AXIS_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "X axis", value: "x" },
	{ label: "Y axis", value: "y" },
	{ label: "Z axis", value: "z" }
]

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

function toRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, kind]) => typeof kind === "string" && kind.length > 0
		)
	) as Record<string, string>
}

function toAxisRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, axis]) => typeof axis === "string" && ["x", "y", "z"].includes(axis)
		)
	) as Record<string, string>
}

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

const ANALYSIS_STORAGE_KEY = "analysis:last"

const Page = () => {
	const [activeTab, setActiveTab] = useState<AnalysisTab>("import")
	const [sessionFolder, setSessionFolder] = useState("")
	const [manifest, setManifest] = useState<any>(null)
	const [analysisResult, setAnalysisResult] = useState<any>(null)
	const [signalKinds, setSignalKinds] = useState<Record<string, string>>({})
	const [signalAxes, setSignalAxes] = useState<Record<string, string>>({})
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

	useBusyGuard(loading ? "Analysis" : null)

	useEffect(() => {
		try {
			const saved = sessionStorage.getItem(ANALYSIS_STORAGE_KEY)
			if (saved) {
				const parsed = JSON.parse(saved)
				if (typeof parsed.sessionFolder === "string") setSessionFolder(parsed.sessionFolder)
				if (parsed.manifest) setManifest(parsed.manifest)
				if (parsed.analysisResult) setAnalysisResult(parsed.analysisResult)
				if (parsed.signalKinds) setSignalKinds(parsed.signalKinds)
				if (parsed.signalAxes) setSignalAxes(parsed.signalAxes)
				if (parsed.excludedChannels && typeof parsed.excludedChannels === "object") setExcludedChannels(parsed.excludedChannels)
				if (parsed.signalKindLibraries && typeof parsed.signalKindLibraries === "object") setSignalKindLibraries(parsed.signalKindLibraries)
				if (parsed.activeTab === "import" || parsed.activeTab === "results") setActiveTab(parsed.activeTab)
				if (typeof parsed.status === "string") setStatus(parsed.status)
				if (typeof parsed.showProgressPanel === "boolean") setShowProgressPanel(parsed.showProgressPanel)
				if (typeof parsed.analysisStartTime === "number") setAnalysisStartTime(parsed.analysisStartTime)
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
				ANALYSIS_STORAGE_KEY,
				JSON.stringify({
					sessionFolder,
					manifest,
					analysisResult,
					signalKinds,
					signalAxes,
					excludedChannels,
					signalKindLibraries,
					activeTab,
					status,
					showProgressPanel,
					outlierRemovalEnabled,
					edaMethodSelection,
					analysisStartTime
				})
			)
		} catch {
			// ignore quota / serialization errors
		}
	}, [hydrated, sessionFolder, manifest, analysisResult, signalKinds, signalAxes, excludedChannels, signalKindLibraries, activeTab, status, showProgressPanel, outlierRemovalEnabled, edaMethodSelection, analysisStartTime])

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

	const appliedSignalAxes = useMemo(() => {
		const existing = toAxisRecord(manifest?.analysis?.signalAxes ?? manifest?.channelSignalAxes)
		return channels.reduce((acc: Record<string, string>, channel) => {
			const selectedKind = signalKinds[channel] ?? toRecord(manifest?.analysis?.signalKinds ?? manifest?.channelSignalKinds)[channel] ?? ""
			const selectedAxis = signalAxes[channel] ?? existing[channel] ?? ""
			if (selectedKind === "acc" && selectedAxis) acc[channel] = selectedAxis
			return acc
		}, {})
	}, [channels, manifest, signalAxes, signalKinds])

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
			if (event.key === "Escape") {
				setShowOutlierRemovalLegend(false)
			}
		}

		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [showOutlierRemovalLegend])

	useEffect(() => {
		if (!showLibraryPolicyLegend) return

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setShowLibraryPolicyLegend(false)
			}
		}

		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [showLibraryPolicyLegend])

	const getOutlierRemovalReason = useCallback((outlierRemoval: any) => {
		if (!outlierRemoval) return ""
		if (typeof outlierRemoval.reason === "string" && outlierRemoval.reason.trim()) {
			return outlierRemoval.reason.trim()
		}
		if (outlierRemoval.biosppy?.reason) {
			return String(outlierRemoval.biosppy.reason)
		}
		if (outlierRemoval.neurokit2?.reason) {
			return String(outlierRemoval.neurokit2.reason)
		}
		return ""
	}, [])

	const getDetailLines = useCallback((row: any) => {
		const lines: string[] = []
		const out = row?.outlierRemoval ?? {}
		const prep = row?.preprocessing ?? {}

		if (prep?.steps?.length) {
			lines.push(`Preprocessing: ${prep.steps.join(", ")}`)
		}

		if (row?.notes) {
			lines.push(`Notes: ${row.notes}`)
		}

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
				if (preprocessing?.steps?.length) {
					notes.push(preprocessing.steps.join(", "))
				}
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
	}, [analysisSource, getChannelAnalysisMetadata])

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
			setSignalAxes(toAxisRecord(sessionManifest.analysis?.signalAxes ?? sessionManifest.channelSignalAxes))

			const existingResult = await window.electronAPI?.readPostHocAnalysisResult?.(folder)
			setAnalysisResult(existingResult || null)
			setStatus(existingResult ? "Loaded session and existing analysis result." : "Loaded session and ready to analyze.")
			setActiveTab("import")
		} catch (loadError) {
			setManifest(null)
			setAnalysisResult(null)
			setSessionFolder("")
			setSignalKinds({})
			setSignalAxes({})
			setStatus("Import failed.")
			setError(loadError instanceof Error ? loadError.message : String(loadError))
			setActiveTab("results")
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
				signalKinds: appliedSignalKinds,
				signalAxes: appliedSignalAxes,
				outlierRemoval: outlierRemovalEnabled,
				edaMethod: edaMethodSelection === "auto" ? undefined : edaMethodSelection,
				excludedChannels: appliedExcludedChannels,
				signalKindLibraries: appliedSignalKindLibraries,
			})
			
			// Check if the result indicates cancellation
			if (result?.cancelled === true) {
				setStatus("Analysis cancelled.")
				setError("")
				window.dispatchEvent(
					new CustomEvent("analysis-error", {
						detail: { message: "Analysis cancelled." }
					})
				)
				return
			}
			
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
	}, [appliedSignalAxes, appliedSignalKinds, sessionFolder, outlierRemovalEnabled, edaMethodSelection, appliedExcludedChannels, appliedSignalKindLibraries])

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
			title="Processing"
			shortTitle="Processing"
			returnHref="/"
			className="container flex flex-col items-center justify-start gap-6 py-8"
		>
			<div className="w-full max-w-4xl space-y-6">
				<div className="rounded-xl border border-background-accent bg-background-accent p-6 shadow-sm">
					<div className="flex flex-col gap-4">
						<div className="space-y-0">
							<p className="text-xs uppercase tracking-[0.24em] text-over-background-low">Post-processing</p>
							<h1 className="font-secondary text-3xl text-over-background-highest">Analysis &amp; Annotation</h1>
							<p className="max-w-2xl text-sm text-over-background-medium">
								Import a session folder, map the channels you want, and run the batch analysis or annotate.
							</p>
						</div>
						<div className="flex flex-wrap gap-3">
							<TextButton size="base" onClick={importSessionFolder} disabled={loading}>
								Import Session Folder
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

							<div className="grid items-start gap-6 lg:grid-cols-5">
								<div className="space-y-0 lg:col-span-3">
									{channels.length > 0 && (
										<p className="flex min-h-[4.5rem] items-center p-4 text-xs text-over-background-medium">Map each channel to a signal type. Uncheck a channel to exclude it from library analysis.</p>
									)}
									{channels.length > 0 ? (
										channels.map(channel => {
											const selectedValue = signalKinds[channel] ?? toRecord(manifest?.channelSignalKinds)[channel] ?? ""
													const selectedAxis = signalAxes[channel] ?? toAxisRecord(manifest?.channelSignalAxes)[channel] ?? ""
											const isExcluded = Boolean(excludedChannels[channel])
											return (
												<div key={channel} className={`flex min-h-[4rem] flex-col rounded-xl border border-background-accent bg-background-accent-light p-3 sm:flex-row sm:items-center sm:justify-between dark:bg-background-accent-dark ${isExcluded ? "opacity-60" : ""}`}>
													<div className="flex items-center justify-between gap-3">
														<label className="flex items-center gap-3" title={isExcluded ? "Excluded — raw series only" : "Included in analysis"}>
															<input
																type="checkbox"
																checked={!isExcluded}
																onChange={event => {
																	const include = event.target.checked
																	setExcludedChannels(current => {
																		const next = { ...current }
																		if (include) {
																			delete next[channel]
																		} else {
																			next[channel] = true
																		}
																		return next
																	})
																}}
															/>
															<div>
																<div className="text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark">{channelNames[channel] ?? channel}</div>
																<div className="text-sm text-over-background-low-light dark:text-over-background-low-dark">Channel {channel}{isExcluded ? " · raw series only" : ""}</div>
															</div>
														</label>
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
																		setSignalAxes(current => {
																			const next = { ...current }
																			if (nextValue === "acc") {
																				next[channel] = next[channel] || "x"
																			} else {
																				delete next[channel]
																			}
																			return next
																		})
															}}
															className="min-w-[7rem] rounded-full border border-background-accent bg-background px-3 py-2 text-sm text-over-background-highest outline-none"
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
																			setSignalAxes(current => ({
																				...current,
																				[channel]: nextAxis
																			}))
																		}}
																		className="min-w-[5rem] rounded-full border border-background-accent bg-background px-3 py-2 text-sm text-over-background-highest outline-none"
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
										<div className="rounded-xl border border-dashed border-background-accent p-4 text-sm text-over-background-medium">
											Import a session folder to load its channels and start annotation or analysis.
										</div>
									)}
								</div>

								{allAssignedKinds.length > 0 ? (
									<div className="space-y-0 lg:col-span-2">
										<p className="flex min-h-[4.5rem] items-center p-4 text-xs text-over-background-medium">Override the analysis library per signal type. &quot;Default&quot; follows the global &quot;Library used&quot;.</p>
										{allAssignedKinds.map(kind => {
											const kindActive = assignedKinds.includes(kind)
											return (
												<div key={`lib-${kind}`} className={`flex min-h-[4rem] items-center gap-3 rounded-xl border border-background-accent bg-background-accent-light p-3 dark:bg-background-accent-dark ${kindActive ? "" : "opacity-60"}`}>
													<span className="min-w-[3rem] text-sm font-medium uppercase text-over-background-highest-light dark:text-over-background-highest-dark">{kind}</span>
													<select
														value={signalKindLibraries[kind] ?? ""}
														disabled={!kindActive}
														title={kindActive ? undefined : "All channels of this signal type are excluded from analysis"}
														onChange={event => {
															const nextValue = event.target.value
															setSignalKindLibraries(current => {
																const next = { ...current }
																if (nextValue === "neurokit" || nextValue === "biosppy") {
																	next[kind] = nextValue
																} else {
																	delete next[kind]
																}
																return next
															})
														}}
														className="min-w-[7rem] rounded-full border border-background-accent bg-background px-3 py-2 text-sm text-over-background-highest outline-none disabled:cursor-not-allowed"
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
						</div>
					) : (
						<div className="-mt-3 space-y-0">
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

							{currentAnalysis && (
								<div className="space-y-0">
									<div className="rounded-xl border border-background-accent bg-background-accent p-4">
										<div className="flex items-center gap-2">
											<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Library policy</p>
											<button
												type="button"
												onClick={() => setShowLibraryPolicyLegend(true)}
												className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background-accent-high text-[11px] font-semibold text-over-background-highest transition-colors hover:bg-background-accent-high"
												aria-label={showLibraryPolicyLegend ? "Hide library policy help" : "Show library policy help"}
												aria-expanded={showLibraryPolicyLegend}
												title="Show library policy help"
											>
												?
											</button>
										</div>
										<p className="p-2 text-sm text-over-background-highest-light dark:text-over-background-highest-dark">
											{analysisPolicy?.summary || "BioSPPy primary + NeuroKit2 secondary on overlapping signals"}
										</p>
										<div className="grid gap-3 sm:grid-cols-2">
											<div className="rounded-lg border border-background-accent-high px-3 py-2">
												<div className="text-xs uppercase tracking-[0.15em] text-over-background-low">Primary library</div>
												<div className="mt-1 text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark">{formatLibraryName(analysisPolicy?.primaryLibrary ?? "biosppy")}</div>
											</div>
											<div className="rounded-lg border border-background-accent-high px-3 py-2">
												<div className="text-xs uppercase tracking-[0.15em] text-over-background-low">Secondary library</div>
												<div className="mt-1 text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark">{formatLibraryName(analysisPolicy?.secondaryLibrary ?? "neurokit2")}</div>
											</div>
										</div>
									</div>
									<div className="rounded-xl border border-background-accent bg-background-accent p-4">
										<div className="flex items-center gap-2">
											<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Summary statistics</p>
										</div>
										<div className="mt-3 rounded-lg border border-background-accent-high p-3">
											<div className="overflow-x-auto">
												<table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-xs text-over-background-highest-light dark:text-over-background-highest-dark">
													<thead>
														<tr>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Segment</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Channel</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Signal kind</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Mean</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Median</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Std</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Min</th>
															<th className="border-b border-background-accent-high px-3 py-2 font-medium">Max</th>
														</tr>
													</thead>
													<tbody>
														{summaryRows.length > 0 ? summaryRows.map((row: any) => (
															<tr key={`${row.segment}-${row.channel}`} className="align-top">
																<td className="border-b border-background-accent-high px-3 py-3">{row.segment ?? "--"}</td>
																<td className="border-b border-background-accent-high px-3 py-3 font-medium">{row.label || row.channel || "--"}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{row.kind || "--"}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{formatNumber(row.summary?.mean)}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{formatNumber(row.summary?.median)}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{formatNumber(row.summary?.std)}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{formatNumber(row.summary?.min)}</td>
																<td className="border-b border-background-accent-high px-3 py-3">{formatNumber(row.summary?.max)}</td>
															</tr>
														)) : (
															<tr>
																<td className="px-3 py-3 text-over-background-medium" colSpan={8}>No summary statistics available.</td>
															</tr>
														)}
													</tbody>
												</table>
											</div>
										</div>	
									</div>
									<div className="rounded-xl border border-background-accent bg-background-accent p-4">
										<div className="flex items-center gap-2">
											<p className="text-xs uppercase tracking-[0.2em] text-over-background-low">Outlier Removal & Preprocessing</p>
											<button
												type="button"
												onClick={() => setShowOutlierRemovalLegend(true)}
												className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-background-accent-high text-[11px] font-semibold text-over-background-highest transition-colors hover:bg-background-accent-high"
												aria-label={showOutlierRemovalLegend ? "Hide outlier removal legend" : "Show outlier removal legend"}
												aria-expanded={showOutlierRemovalLegend}
												title="Show outlier removal legend"
											>
												?
											</button>
										</div>
										{segmentAnalysisRows.length > 0 ? (
											<div className="mt-3 space-y-4 text-sm">
												{(Array.from(new Set(segmentAnalysisRows.map((row: any) => String(row.segment)))) as string[]).map(segmentId => {
													const rows = segmentAnalysisRows.filter((row: any) => String(row.segment) === segmentId)
													return (
														<div key={segmentId} className="rounded-lg border border-background-accent-high p-3">
															<div className="mb-3 text-sm font-semibold">Segment {segmentId}</div>
															<div className="overflow-x-auto">
																<table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-xs text-over-background-highest-light dark:text-over-background-highest-dark">
																	<thead>
																		<tr>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Channel</th>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Kind</th>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Peaks in the Session</th>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Peaks kept</th>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Rejected</th>
																			<th className="border-b border-background-accent-high px-3 py-2 font-medium">Rate</th>
																		</tr>
																	</thead>
																	<tbody>
																		{rows.map((entry: any) => {
																			const rowKey = `${entry.segment}-${entry.channel}`
																			const detailLines = getDetailLines(entry)
																			return (
																				<tr key={rowKey} className="align-top">
																					<td className="border-b border-background-accent-high px-3 py-3 font-medium">{entry.label || entry.channel}</td>
																					<td className="border-b border-background-accent-high px-3 py-3">{entry.kind || "--"}</td>
																					<td className="border-b border-background-accent-high px-3 py-3">{formatTableCount(entry.inputCount)}</td>
																					<td className="border-b border-background-accent-high px-3 py-3">{formatTableCount(entry.keptCount)}</td>
																					<td className="border-b border-background-accent-high px-3 py-3">{formatTableCount(entry.rejectedCount)}</td>
																					<td className="border-b border-background-accent-high px-3 py-3">
																						<div className="flex items-center justify-between gap-3">
																							<div>{formatTablePercent(entry.rate)}</div>
																							{detailLines.length > 0 && (
																								<button
																									type="button"
																									onClick={() => { setSelectedDetailEntry(entry); setShowDetailModal(true) }}
																									className="ml-3 rounded px-2 py-1 text-xs text-over-background-low bg-background-accent-high hover:opacity-90"
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
										<p className="mt-3 text-sm text-over-background-medium">No preprocessing or outlier removal metadata was recorded for this analysis.</p>
									)}
								</div>
							</div>
							)}
						</div>
					)}
				</section>
			</div>

			<AnalysisProgressPanel
				key={analysisStartTime}
				isVisible={showProgressPanel}
				startTime={analysisStartTime}
				onRetry={proceedWithAnalysis}
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
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-90"
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
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-90"
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
								className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-90"
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
									<div className="mt-1 text-sm">{selectedDetailEntry.preprocessing.steps.join(", ")}</div>
								</div>
							) : null}

							<div className="mb-4">
								<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Outlier removal</div>
								<div className="mt-1 text-sm">
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
								<div className="mt-1 text-sm">Finite values sanitized: {typeof (selectedDetailEntry.outlierRemoval?.sanitizedCount ?? selectedDetailEntry.outlierRemoval?.finiteValueSanitization?.removedCount ?? selectedDetailEntry.preprocessing?.sanitizedCount) === "number" ? (selectedDetailEntry.outlierRemoval?.sanitizedCount ?? selectedDetailEntry.outlierRemoval?.finiteValueSanitization?.removedCount ?? selectedDetailEntry.preprocessing?.sanitizedCount) : 0}</div>
							</div>

							{selectedDetailEntry.notes && (
								<div className="mb-1">
									<div className="text-xs font-medium text-over-background-medium-dark dark:text-over-background-medium-light">Notes</div>
									<div className="mt-1 text-sm">{selectedDetailEntry.notes}</div>
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{showReAnalysisDialog && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
					<div className="w-full max-w-md rounded-lg bg-background-accent-light p-6 shadow-lg dark:bg-background-accent-dark">
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