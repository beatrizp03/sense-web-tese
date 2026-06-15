import { useCallback, useEffect, useMemo, useState } from "react"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import SenseLayout from "../components/layout/SenseLayout"
import SessionChart from "../components/processing/SessionChart"
import ProcessingSidePanel, { SidePanelTab } from "../components/processing/ProcessingSidePanel"
import AnalysisPanel from "../components/processing/AnalysisPanel"
import AnnotationsPanel from "../components/processing/AnnotationsPanel"
import SessionExportBar from "../components/processing/SessionExportBar"
import { toRecord, toAxisRecord } from "../components/processing/analysisShared"
import { useBusyGuard } from "../hooks/useBusyGuard"
import { useAnnotations } from "../hooks/useAnnotations"
import { useAnnotationLabels } from "../utils/annotationLabels"

const SESSION_STORAGE_KEY = "processing:session"

type AnalysisRange = { startSec: number; endSec: number }

const Page = () => {
	const [sessionFolder, setSessionFolder] = useState("")
	const [manifest, setManifest] = useState<any>(null)
	const [signalKinds, setSignalKinds] = useState<Record<string, string>>({})
	const [signalAxes, setSignalAxes] = useState<Record<string, string>>({})
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState("")
	const [hydrated, setHydrated] = useState(false)
	const [analysisBusy, setAnalysisBusy] = useState(false)
	const [windowRange, setWindowRange] = useState<AnalysisRange | null>(null)
	const [selectedSegment, setSelectedSegment] = useState(1)
	const [activeSideTab, setActiveSideTab] = useState<SidePanelTab>("analysis")

	const annotating = activeSideTab === "annotations"

	const { labels: annotationLabels } = useAnnotationLabels()
	const annotations = useAnnotations({
		sessionFolder,
		enabled: annotating,
		labels: annotationLabels
	})

	useBusyGuard(
		loading || analysisBusy
			? "Analysis"
			: annotations.dirty
				? "You have unsaved annotations."
				: null
	)

	const confirmDiscard = useCallback(() => {
		if (!annotations.dirty) return true
		return window.confirm("Annotations unsaved. Do you want to proceed?")
	}, [annotations.dirty])

	const annotationItems = useMemo(() => {
		const byId = new Map(annotationLabels.map(l => [l.id, l]))
		return annotations.annotations
			.filter(a => a.segment === selectedSegment)
			.sort((a, b) => a.startSec - b.startSec)
			.map(a => {
				const label = byId.get(a.labelId)
				return {
					id: a.id,
					type: a.type,
					startSec: a.startSec,
					endSec: a.endSec,
					color: label?.color ?? "#888888",
					labelName: label?.name ?? "",
					note: a.note ?? ""
				}
			})
	}, [annotations.annotations, selectedSegment, annotationLabels])

	useEffect(() => {
		try {
			const saved = sessionStorage.getItem(SESSION_STORAGE_KEY)
			if (saved) {
				const parsed = JSON.parse(saved)
				if (typeof parsed.sessionFolder === "string") setSessionFolder(parsed.sessionFolder)
				if (parsed.manifest) setManifest(parsed.manifest)
				if (parsed.signalKinds) setSignalKinds(parsed.signalKinds)
				if (parsed.signalAxes) setSignalAxes(parsed.signalAxes)
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
				SESSION_STORAGE_KEY,
				JSON.stringify({ sessionFolder, manifest, signalKinds, signalAxes })
			)
		} catch {
			// ignore quota / serialization errors
		}
	}, [hydrated, sessionFolder, manifest, signalKinds, signalAxes])

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

	const loadSessionBundle = useCallback(async (folder: string) => {
		setError("")
		setLoading(true)
		try {
			const sessionManifest = await window.electronAPI?.readSessionManifest?.(`${folder}/session.json`)
			if (!sessionManifest) {
				throw new Error("The selected folder does not contain a readable session.json file.")
			}

			const manifestChannels = Array.isArray(sessionManifest.channels) ? sessionManifest.channels : []
			const manifestChunks = Array.isArray(sessionManifest.chunks) ? sessionManifest.chunks : []
			if (manifestChannels.length === 0) {
				throw new Error("This session has no channels to draw. Select a folder from a finalized acquisition.")
			}
			if (manifestChunks.length === 0) {
				throw new Error("This session contains no recorded data chunks to draw. Select a folder with acquired signal data.")
			}

			setSessionFolder(folder)
			setManifest(sessionManifest)
			setSignalKinds(toRecord(sessionManifest.analysis?.signalKinds ?? sessionManifest.channelSignalKinds))
			setSignalAxes(toAxisRecord(sessionManifest.analysis?.signalAxes ?? sessionManifest.channelSignalAxes))
		} catch (loadError) {
			setManifest(null)
			setSessionFolder("")
			setSignalKinds({})
			setSignalAxes({})
			setError(loadError instanceof Error ? loadError.message : String(loadError))
		} finally {
			setLoading(false)
		}
	}, [])

	const importSessionFolder = useCallback(async () => {
		if (!confirmDiscard()) return
		const folder = await window.electronAPI?.selectAnalysisSessionFolder?.()
		if (!folder) return
		await loadSessionBundle(folder)
	}, [loadSessionBundle, confirmDiscard])

	const chunkCount = Array.isArray(manifest?.chunks) ? manifest.chunks.length : 0
	const segments = useMemo(() => (Array.isArray(manifest?.segments) ? manifest.segments : []), [manifest])
	const hasSession = channels.length > 0 && chunkCount > 0

	useEffect(() => {
		setSelectedSegment(1)
	}, [sessionFolder])

	const analysisPanel = (
		<AnalysisPanel
			sessionFolder={sessionFolder}
			manifest={manifest}
			channels={channels}
			channelNames={channelNames}
			signalKinds={signalKinds}
			setSignalKinds={setSignalKinds}
			signalAxes={signalAxes}
			setSignalAxes={setSignalAxes}
			appliedSignalKinds={appliedSignalKinds}
			appliedSignalAxes={appliedSignalAxes}
			windowRange={windowRange}
			selectedSegment={selectedSegment}
			onBusyChange={setAnalysisBusy}
		/>
	)

	return (
		<SenseLayout
			title="Processing"
			shortTitle="Processing"
			returnHref="/"
			className="container flex flex-col items-center justify-start gap-6 p-8"
		>
			<div className="w-full max-w-5xl space-y-6">
				{hasSession ? (
					<div className="grid grid-cols-3 gap-4">
						<div className="col-span-2 space-y-6">
							<div className="grid grid-cols-5 gap-2 items-stretch">
								<div className="col-span-4 flex items-center rounded-xl border border-background-accent bg-background-accent px-6 py-3 shadow-sm">
									<div className="min-w-0 space-y-0">
										<p className="text-xs uppercase tracking-[0.24em] text-over-background-low">Imported session</p>
										<p className="break-all text-sm text-over-background-highest">{sessionFolder}</p>
									</div>
								</div>
								<div className="col-span-1 flex items-center py-1 rounded-l">
									<TextButton size="base" className="text-xs !h-full w-full motion-safe:hover:!scale-95 motion-safe:active:!scale-95" onClick={importSessionFolder} disabled={loading || analysisBusy}>
										Import New Folder
									</TextButton>
								</div>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{segments.length > 0 && (
									<>
										<span className="text-xs uppercase tracking-[0.2em] text-over-background-low">Segment</span>
										{segments.map((_: any, i: number) => {
											const seg = i + 1
											return (
												<button
													key={seg}
													type="button"
													onClick={() => {
														if (seg === selectedSegment) return
														annotations.clearInteraction()
														setSelectedSegment(seg)
													}}
													className={`rounded-full px-3 py-1 text-xs font-medium transition ${selectedSegment === seg ? "bg-over-background-low-light text-over-background-high-light dark:bg-over-primary-medium-light dark:text-over-background-highest-light" : "bg-background-accent text-over-background-medium hover:opacity-80"}`}
												>
													Segment {seg}
												</button>
											)
										})}
									</>
								)}
								<span className="ml-auto inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-over-background-medium">
									{annotating ? (
										<span className="relative inline-flex h-2.5 w-2.5">
											<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-over-background-medium opacity-75" />
											<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-over-background-highest" />
										</span>
									) : (
										<span className="text-xs inline-flex h-2.5 w-2.5 rounded-full border border-over-background-medium" />
									)}
									{annotating ? "Annotation ON" : "Annotation OFF"}
								</span>
							</div>
							<SessionChart
								channels={channels}
								manifest={manifest}
								sessionFolder={sessionFolder}
								channelNames={channelNames}
								signalKinds={appliedSignalKinds}
								signalAxes={appliedSignalAxes}
								selectedSegment={selectedSegment}
								onWindowRangeChange={setWindowRange}
								annotating={annotating}
								annotations={annotations.annotations}
								labels={annotationLabels}
								selectedAnnotationId={annotations.selectedId}
								draft={annotations.draft}
								onChartClick={annotations.handleChartClick}
							/>
						</div>
						<div className="col-span-1">
							<ProcessingSidePanel
								analysisContent={analysisPanel}
								annotationsContent={
									<AnnotationsPanel
										annotationCount={annotationItems.length}
										dirty={annotations.dirty}
										saving={annotations.saving}
										onSave={annotations.save}
										mode={annotations.mode}
										onToggleMode={annotations.toggleMode}
										activeLabelId={annotations.activeLabelId}
										onSelectLabel={annotations.setActiveLabelId}
										items={annotationItems}
										selectedId={annotations.selectedId}
										onSelectAnnotation={annotations.setSelectedId}
										onRemoveAnnotation={annotations.removeAnnotation}
										onSetNote={annotations.setAnnotationNote}
									/>
								}
								exportContent={<SessionExportBar manifest={manifest} withDescriptions />}
								onActiveTabChange={setActiveSideTab}
								onBeforeTabChange={(from, to) =>
									from === "annotations" && to !== "annotations" ? confirmDiscard() : true
								}
							/>
						</div>
					</div>
				) : (
					<div className="rounded-xl border border-background-accent bg-background-accent p-6 shadow-sm">
						<div className="flex flex-col gap-4">
							<div className="space-y-0">
								<p className="text-xs uppercase tracking-[0.24em] text-over-background-low">Post-processing</p>
								<h1 className="font-secondary text-3xl text-over-background-highest">Analysis and Annotation</h1>
								<p className="max-w-2xl text-sm text-over-background-medium">
									Import a session folder, map the channels you want, and run the batch analysis or annotate.
								</p>
							</div>
							<div className="flex flex-wrap gap-3">
								<TextButton size="base" onClick={importSessionFolder} disabled={loading}>
									Import Session Folder
								</TextButton>
							</div>

							{error && (
								<div
									role="alert"
									className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400"
								>
									<p className="text-sm font-medium">This folder could not be imported</p>
									<p className="mt-1 text-xs text-red-600/95 dark:text-red-400/95">{error}</p>
									<p className="mt-2 text-xs text-red-600/80 dark:text-red-400/80">Please select another folder.</p>
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</SenseLayout>
	)
}

export default Page
