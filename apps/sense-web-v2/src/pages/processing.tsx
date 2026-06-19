import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useRouter } from "next/router"
import resolveConfig from "tailwindcss/resolveConfig"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import tailwindConfig from "../../tailwind.config"
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

const fullConfig = resolveConfig(tailwindConfig)
const backgroundDarkColor =
	(fullConfig.theme as any)?.colors?.["background-dark"] ?? "#1C1C1E"

type AnalysisRange = { startSec: number; endSec: number }

function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
	if (!match) return hex
	const int = parseInt(match[1], 16)
	return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

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
	const [segLabelMenu, setSegLabelMenu] = useState<number | null>(null)

	const annotating = activeSideTab === "annotations"

	const { labels: annotationLabels } = useAnnotationLabels()
	const annotations = useAnnotations({
		sessionFolder,
		enabled: annotating,
		labels: annotationLabels,
		sampleRate: Number(manifest?.sampleRate) || undefined,
		segments: Array.isArray(manifest?.segments) ? manifest.segments : undefined
	})

	useBusyGuard(
		loading || analysisBusy
			? "Analysis"
			: annotations.dirty
				? "You have unsaved annotations."
				: null
	)

	const [discardAction, setDiscardAction] = useState<(() => void) | null>(null)

	const requestDiscard = useCallback(
		(onConfirm: () => void) => {
			if (!annotations.dirty) {
				onConfirm()
				return
			}
			setDiscardAction(() => onConfirm)
		},
		[annotations.dirty]
	)

	const handleTabChange = useCallback(
		(to: SidePanelTab) => {
			if (activeSideTab === "annotations" && to !== "annotations") {
				requestDiscard(() => setActiveSideTab(to))
			} else {
				setActiveSideTab(to)
			}
		},
		[activeSideTab, requestDiscard]
	)

	const router = useRouter()
	const allowNavRef = useRef(false)

	// Electron window close (X): show the unsaved-annotations modal instead of
	// silently blocking the close. If clean, let the window close.
	useEffect(() => {
		if (!window.electronAPI?.onShowCloseWarning) return
		return window.electronAPI.onShowCloseWarning(() => {
			if (annotations.dirty) {
				setDiscardAction(() => () => window.electronAPI?.confirmClose?.(true))
			} else if (!loading && !analysisBusy) {
				window.electronAPI?.confirmClose?.(true)
			}
		})
	}, [annotations.dirty, loading, analysisBusy])

	// Client-side navigation (Home/return button, links): same modal guard.
	useEffect(() => {
		const handler = (url: string) => {
			if (allowNavRef.current) {
				allowNavRef.current = false
				return
			}
			if (annotations.dirty) {
				setDiscardAction(() => () => {
					allowNavRef.current = true
					void router.push(url)
				})
				router.events.emit("routeChangeError", "aborted", url)
				// Throwing aborts the in-flight navigation (Next.js pattern).
				// eslint-disable-next-line no-throw-literal
				throw "Navigation blocked: unsaved annotations."
			}
		}
		router.events.on("routeChangeStart", handler)
		return () => router.events.off("routeChangeStart", handler)
	}, [annotations.dirty, router])

	const labels = annotations.labels
	const labelById = useMemo(() => new Map(labels.map(l => [l.id, l])), [labels])
	const segmentScopedLabels = useMemo(
		() => labels.filter(l => l.appliesTo === "segment" && !l.retired),
		[labels]
	)

	const annotationItems = useMemo(() => {
		return annotations.annotations
			.filter(a => a.segment === selectedSegment)
			.sort((a, b) => a.t0 - b.t0)
			.map(a => {
				const label = labelById.get(a.labelId)
				return {
					id: a.id,
					t0: a.t0,
					t1: a.t1,
					color: label?.color ?? "#888888",
					labelId: a.labelId,
					labelName: label?.name ?? "",
					note: a.note ?? ""
				}
			})
	}, [annotations.annotations, selectedSegment, labelById])

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

	const importSessionFolder = useCallback(() => {
		requestDiscard(async () => {
			const folder = await window.electronAPI?.selectAnalysisSessionFolder?.()
			if (!folder) return
			await loadSessionBundle(folder)
		})
	}, [loadSessionBundle, requestDiscard])

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
											const segLabel = labelById.get(annotations.segmentLabels[seg])
											const tint = segLabel ? hexToRgba(segLabel.color, selectedSegment === seg ? 0.55 : 0.15) : undefined
											return (
												<span key={seg} className="relative inline-flex">
													<button
														type="button"
														title={segLabel ? `Segment ${seg} · ${segLabel.name} (double-click to change)` : `Segment ${seg} (double-click to label)`}
														onClick={() => {
															if (seg === selectedSegment) return
															annotations.clearInteraction()
															setSelectedSegment(seg)
														}}
														onDoubleClick={() => setSegLabelMenu(prev => (prev === seg ? null : seg))}
														style={tint ? { backgroundColor: tint } : undefined}
														className={`rounded-full px-3 py-1 text-xs font-medium transition ${
															tint
																? "text-over-background-highest"
																: selectedSegment === seg
																	? "bg-over-background-low-light text-over-background-high-light dark:bg-over-primary-medium-light dark:text-over-background-highest-light"
																	: "bg-background-accent text-over-background-medium hover:opacity-80"
														} ${selectedSegment === seg ? "ring-1 ring-background-accent-light/50 ring-offset-1 ring-offset-background" : ""}`}
													>
														Segment {seg}
													</button>
													{segLabelMenu === seg && (
														<>
															{/* click-away */}
															<div className="fixed inset-0 z-10" onClick={() => setSegLabelMenu(null)} role="presentation" />
															<div className="absolute left-0 top-full z-20 mt-1 min-w-[10rem] rounded-lg border border-background-accent bg-background p-1.5 shadow-xl">
																<p className="px-1.5 py-1 text-[10px] uppercase tracking-[0.18em] text-over-background-low">
																	Label segment {seg}
																</p>
																{segmentScopedLabels.length === 0 ? (
																	<p className="px-1.5 py-1 text-xs text-over-background-low">No segment labels defined.</p>
																) : (
																	segmentScopedLabels.map(label => {
																		const active = annotations.segmentLabels[seg] === label.id
																		return (
																			<button
																				key={label.id}
																				type="button"
																				onClick={() => {
																					annotations.setSegmentLabel(seg, active ? null : label.id)
																					setSegLabelMenu(null)
																				}}
																				className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${active ? "bg-primary/10" : "hover:bg-background-accent"}`}
																			>
																				<span className="h-3 w-3 shrink-0 rounded-full text-xs" style={{ backgroundColor: label.color }} />
																				<span className="text-over-background-highest text-xs">{label.name}</span>
																				{active && <span className="ml-auto text-background-accent-light">✓</span>}
																			</button>
																		)
																	})
																)}
																{annotations.segmentLabels[seg] != null && (
																	<button
																		type="button"
																		onClick={() => {
																			annotations.setSegmentLabel(seg, null)
																			setSegLabelMenu(null)
																		}}
																		className="mt-1 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-over-background-medium transition-colors hover:bg-background-accent"
																	>
																		Clear label
																	</button>
																)}
															</div>
														</>
													)}
												</span>
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
									{annotating ? "Annotations ON" : "Annotations OFF"}
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
								labels={labels}
								selectedAnnotationId={annotations.selectedId}
								draft={annotations.draft}
								onChartClick={annotations.handleChartClick}
								onAnnotationDragBound={annotations.setAnnotationBounds}
								onAnnotationMove={annotations.setAnnotationSpan}
							/>
						</div>
						<div className="col-span-1">
							<ProcessingSidePanel
								analysisContent={analysisPanel}
								annotationsContent={
									<AnnotationsPanel
										labels={labels}
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
										onSetLabel={annotations.setAnnotationLabel}
										onClearAll={() =>
											windowRange &&
											annotations.clearAnnotationsInRange(
												selectedSegment,
												windowRange.startSec,
												windowRange.endSec
											)
										}
										onUndo={annotations.undo}
										onRedo={annotations.redo}
										canUndo={annotations.canUndo}
										canRedo={annotations.canRedo}
										onLabelsChange={annotations.setLabels}
									/>
								}
								exportContent={
									<SessionExportBar
										manifest={manifest}
										withDescriptions
										annotations={annotations.annotations}
										labels={labels}
										defaultSegment={selectedSegment}
										defaultRange={windowRange}
									/>
								}
								activeTab={activeSideTab}
								onTabChange={handleTabChange}
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

			{discardAction && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
					<div
						className="w-full max-w-md rounded-lg p-8 text-white shadow-lg"
						style={{ backgroundColor: `${backgroundDarkColor}E6` }}
					>
						<h2 className="mb-4 text-xl font-bold text-red-600">Unsaved Annotations</h2>
						<p className="mb-4">
							You have unsaved annotations. Do you want to proceed and discard them?
						</p>
						<div className="flex justify-end gap-4">
							<button
								type="button"
								onClick={() => setDiscardAction(null)}
								className="rounded-lg border border-over-background-highest-light dark:border-over-background-highest-dark bg-background-accent-light dark:bg-background-accent-dark px-4 py-2 text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark hover:opacity-80"
							>
								Cancel
							</button>
							<TextButton
								size="base"
								className="!text-sm"
								onClick={() => {
									const run = discardAction
									setDiscardAction(null)
									void annotations.discardChanges()
									run()
								}}
							>
								Proceed
							</TextButton>
						</div>
					</div>
				</div>
			)}
		</SenseLayout>
	)
}

export default Page
