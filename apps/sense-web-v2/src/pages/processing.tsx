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
import ProcessingHelpOverlay from "../components/processing/ProcessingHelpOverlay"
import HelpHint from "../components/processing/HelpHint"
import { toRecord, toAxisRecord } from "../components/processing/analysisShared"
import { useBusyGuard } from "../hooks/useBusyGuard"
import { useAnnotations } from "../hooks/useAnnotations"
import { useAnnotationLabels } from "../utils/annotationLabels"

const SESSION_STORAGE_KEY = "processing:session"
const HELP_SEEN_STORAGE_KEY = "processing:helpSeen"

const fullConfig = resolveConfig(tailwindConfig)
const backgroundDarkColor =
	(fullConfig.theme as any)?.colors?.["background-dark"] ?? "#1C1C1E"

type AnalysisRange = { startSec: number; endSec: number }

type ConfirmLeave = { title: string; body: string; confirmLabel?: string; onConfirm?: () => void }

const EXPORT_NOTICE: ConfirmLeave = {
	title: "Export in progress",
	body: "A file is still being exported. Please wait for it to finish before leaving."
}

function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
	if (!match) return hex
	const int = parseInt(match[1], 16)
	return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

/** "2h 04m" / "12m 30s" / "45s" — how long the recording actually lasts. */
function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return ""
	const total = Math.round(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
	return `${s}s`
}

const SEGMENTS_HELP =
	"Segments are the chunks of a single recording: a new one starts every time you pause and resume the acquisition. They are not channels, every channel is present in every segment."

const ANNOTATION_TOOLS: { mode: "point" | "interval"; label: string; shortcut: string }[] = [
	{ mode: "point", label: "Point", shortcut: "P" },
	{ mode: "interval", label: "Interval", shortcut: "I" }
]

/** A dot for the point tool, a bounded bar for the interval tool. */
const ToolIcon: React.FC<{ mode: "point" | "interval" }> = ({ mode }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3 shrink-0">
		{mode === "point" ? (
			<circle cx="8" cy="8" r="3.5" fill="currentColor" />
		) : (
			<>
				<rect x="3" y="3" width="1.6" height="10" fill="currentColor" />
				<rect x="11.4" y="3" width="1.6" height="10" fill="currentColor" />
				<rect x="4.6" y="7.2" width="6.8" height="1.6" fill="currentColor" opacity="0.7" />
			</>
		)}
	</svg>
)

const Page = () => {
	const [sessionFolder, setSessionFolder] = useState("")
	const [manifest, setManifest] = useState<any>(null)
	const [signalKinds, setSignalKinds] = useState<Record<string, string>>({})
	const [signalAxes, setSignalAxes] = useState<Record<string, string>>({})
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState("")
	const [hydrated, setHydrated] = useState(false)
	const [analysisBusy, setAnalysisBusy] = useState(false)
	const [exportBusy, setExportBusy] = useState(false)
	const [windowRange, setWindowRange] = useState<AnalysisRange | null>(null)
	const [selectedSegment, setSelectedSegment] = useState(1)
	const [activeSideTab, setActiveSideTab] = useState<SidePanelTab>("analysis")
	const [segLabelMenu, setSegLabelMenu] = useState<number | null>(null)
	const [helpOpen, setHelpOpen] = useState(false)
	const [bannerDismissed, setBannerDismissed] = useState(false)
	const [chunkLengths, setChunkLengths] = useState<{ file: string; frames: number }[] | null>(null)

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
			: exportBusy
				? "Exporting a file"
				: annotations.dirty
					? "You have unsaved annotations."
					: null
	)

	const [confirmLeave, setConfirmLeave] = useState<ConfirmLeave | null>(null)

	const buildDiscardLeave = useCallback(
		(onConfirm: () => void): ConfirmLeave => ({
			title: "Unsaved Annotations",
			body: "You have unsaved annotations. Do you want to proceed and discard them?",
			confirmLabel: "Proceed",
			onConfirm: () => {
				void annotations.discardChanges()
				onConfirm()
			}
		}),
		[annotations.discardChanges]
	)

	const requestDiscard = useCallback(
		(onConfirm: () => void) => {
			if (!annotations.dirty) {
				onConfirm()
				return
			}
			setConfirmLeave(buildDiscardLeave(onConfirm))
		},
		[annotations.dirty, buildDiscardLeave]
	)

	const guardLeave = useCallback(
		(onConfirm: () => void) => {
			if (annotations.dirty) {
				setConfirmLeave(buildDiscardLeave(onConfirm))
			} else if (exportBusy) {
				setConfirmLeave(EXPORT_NOTICE)
			} else {
				onConfirm()
			}
		},
		[annotations.dirty, exportBusy, buildDiscardLeave]
	)

	const handleTabChange = useCallback(
		(to: SidePanelTab) => {
			if (to === activeSideTab) return
			guardLeave(() => setActiveSideTab(to))
		},
		[activeSideTab, guardLeave]
	)

	const router = useRouter()
	const allowNavRef = useRef(false)

	// Electron window close (X): show the unsaved-annotations modal instead of
	// silently blocking the close. If clean, let the window close.
	useEffect(() => {
		if (!window.electronAPI?.onShowCloseWarning) return
		return window.electronAPI.onShowCloseWarning(() => {
			const confirmClose = () => window.electronAPI?.confirmClose?.(true)
			if (annotations.dirty) {
				setConfirmLeave(buildDiscardLeave(confirmClose))
			} else if (exportBusy) {
				setConfirmLeave(EXPORT_NOTICE)
			} else if (!loading && !analysisBusy) {
				confirmClose()
			}
		})
	}, [annotations.dirty, exportBusy, loading, analysisBusy, buildDiscardLeave])

	// Client-side navigation (Home/return button, links): same modal guard.
	useEffect(() => {
		const handler = (url: string) => {
			if (allowNavRef.current) {
				allowNavRef.current = false
				return
			}
			if (annotations.dirty || exportBusy) {
				if (annotations.dirty) {
					setConfirmLeave(
						buildDiscardLeave(() => {
							allowNavRef.current = true
							void router.push(url)
						})
					)
				} else {
					setConfirmLeave(EXPORT_NOTICE)
				}
				router.events.emit("routeChangeError", "aborted", url)
				throw "Navigation blocked: unfinished work."
			}
		}
		router.events.on("routeChangeStart", handler)
		return () => router.events.off("routeChangeStart", handler)
	}, [annotations.dirty, exportBusy, router, buildDiscardLeave])

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
		if (!annotating) setSegLabelMenu(null)
	}, [annotating])

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

	const autoImportedRef = useRef<string | null>(null)
	useEffect(() => {
		if (!hydrated || !router.isReady) return
		const q = router.query.session
		const folder = Array.isArray(q) ? q[0] : q
		if (!folder || autoImportedRef.current === folder) return
		autoImportedRef.current = folder
		if (folder !== sessionFolder) {
			void loadSessionBundle(folder)
		}
	}, [hydrated, router.isReady, router.query.session, sessionFolder, loadSessionBundle])

	const chunkCount = Array.isArray(manifest?.chunks) ? manifest.chunks.length : 0
	const segments = useMemo(() => (Array.isArray(manifest?.segments) ? manifest.segments : []), [manifest])
	const hasSession = channels.length > 0 && chunkCount > 0

	const sessionSummary = useMemo(() => {
		const parts: string[] = []
		if (channels.length > 0) parts.push(`${channels.length} channel${channels.length === 1 ? "" : "s"}`)
		const totalSeconds =
			segments.reduce((acc: number, seg: any) => {
				const start = Number(seg?.startedAt)
				const end = Number(seg?.endedAt)
				return Number.isFinite(start) && Number.isFinite(end) && end > start ? acc + (end - start) : acc
			}, 0) / 1000
		const duration = formatDuration(totalSeconds)
		if (duration) parts.push(duration)
		if (segments.length > 0) parts.push(`${segments.length} segment${segments.length === 1 ? "" : "s"}`)
		const rate = Number(manifest?.sampleRate)
		if (Number.isFinite(rate) && rate > 0) parts.push(`${rate} Hz`)
		return parts.join(" · ")
	}, [channels, segments, manifest])

	useEffect(() => {
		if (!hasSession) return
		try {
			if (window.localStorage.getItem(HELP_SEEN_STORAGE_KEY)) return
			window.localStorage.setItem(HELP_SEEN_STORAGE_KEY, "1")
		} catch {
			return
		}
		setHelpOpen(true)
	}, [hasSession])

	useEffect(() => {
		setBannerDismissed(false)
	}, [annotating])

	const annotationBannerMessage = useMemo(() => {
		if (annotations.mode === "point") return "Point tool on - click on the graph to place a point."
		if (annotations.mode === "interval") {
			return annotations.draft
				? "Interval tool on - click on the graph again to set the end of the interval. Esc cancels."
				: "Interval tool on - click on the graph to set the start of the interval (not on the minimap below it)."
		}
		return "Annotation mode is on. Pick Point or Interval, then click on the graph. With no tool picked, clicking only selects existing annotations."
	}, [annotations.mode, annotations.draft])

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
			<button
				type="button"
				onClick={() => setHelpOpen(true)}
				title="Quick start: what this page does"
				className="fixed right-5 top-20 z-20 inline-flex items-center gap-1.5 rounded-full border border-background-accent bg-background-accent px-2.5 py-1 text-xs uppercase tracking-[0.18em] text-over-background-medium shadow-sm transition-colors hover:border-primary hover:text-primary"
			>
				Help
			</button>

			<div className="w-full max-w-5xl space-y-6">
				{hasSession ? (
					<div className="grid grid-cols-3 gap-4">
						<div className="col-span-2 space-y-6">
							<div className="grid grid-cols-5 gap-2 items-stretch">
								<div className="col-span-4 rounded-xl border border-background-accent bg-background-accent px-6 py-3 shadow-sm">
									<p className="text-xs uppercase tracking-[0.24em] text-over-background-low">Imported session</p>
									<p className="break-all text-sm text-over-background-highest">{sessionFolder}</p>
									<div className="mt-0.5 flex items-center gap-3">
										{sessionSummary && (
											<p className="min-w-0 text-xs font-medium tabular-nums text-over-background-medium">
												{sessionSummary}
											</p>
										)}
										<button
											type="button"
											onClick={() => void window.electronAPI?.openExternalPath?.(sessionFolder)}
											title={`Open ${sessionFolder} in the file explorer`}
											className="ml-auto shrink-0 whitespace-nowrap rounded-lg bg-over-background-low-light p-2 text-xs font-medium text-over-background-high-light transition hover:bg-over-background-medium-light dark:bg-over-primary-medium-light dark:text-over-background-highest-light dark:hover:bg-over-primary-low-light"
										>
											Open folder on file explorer
										</button>
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
										<span className="relative inline-flex items-center text-xs uppercase text-over-background-low">
											<HelpHint
												label="What is a segment?"
												width="w-[22rem]"
												className="absolute right-full mr-1.5"
											>
												<p className="text-[11px] uppercase tracking-[0.2em] text-over-background-low">Segments</p>
												<p className="mt-1 text-xs text-over-background-medium">{SEGMENTS_HELP}</p>
											</HelpHint>
											<span className="tracking-[0.2em] text-sm">Segment</span>
										</span>
										{segments.map((_: any, i: number) => {
											const seg = i + 1
											const segLabel = labelById.get(annotations.segmentLabels[seg])
											const tint = segLabel ? hexToRgba(segLabel.color, selectedSegment === seg ? 0.55 : 0.15) : undefined
											return (
												<span key={seg} className="relative inline-flex">
													<button
														type="button"
														aria-haspopup="menu"
														aria-expanded={segLabelMenu === seg}
														title={
															!annotating
																? `Segment ${seg} - turn on Annotations to label segments`
																: segLabel
																	? `Segment ${seg} · ${segLabel.name} (click to change label)`
																	: `Segment ${seg} (click to label)`
														}
														onClick={() => {
															if (seg !== selectedSegment) {
																annotations.clearInteraction()
																setSelectedSegment(seg)
															}
															if (!annotating) {
																setSegLabelMenu(null)
																return
															}
															setSegLabelMenu(prev => (prev === seg ? null : seg))
														}}
														style={tint ? { backgroundColor: tint } : undefined}
														className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
															tint
																? "text-over-background-highest"
																: selectedSegment === seg
																	? "bg-over-background-low-light text-over-background-high-light dark:bg-over-primary-medium-light dark:text-over-background-highest-light"
																	: "bg-background-accent text-over-background-medium hover:opacity-80"
														} ${selectedSegment === seg ? "ring-1 ring-background-accent-light/50 ring-offset-1 ring-offset-background" : ""}`}
													>
														Segment {seg}
														<svg
															viewBox="0 0 12 12"
															aria-hidden="true"
															className={`h-2.5 w-2.5 shrink-0 transition-transform ${segLabelMenu === seg ? "rotate-180" : ""} ${annotating ? "opacity-70" : "opacity-30"}`}
														>
															<path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
														</svg>
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
								<button
									type="button"
									role="switch"
									aria-checked={annotating}
									aria-label="Annotations"
									onClick={() => handleTabChange(annotating ? "analysis" : "annotations")}
									title={annotating ? "Turn annotations off" : "Turn annotations on"}
									className="ml-auto inline-flex items-center gap-2 rounded px-1 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-over-background-medium outline-none transition-colors hover:text-over-background-highest focus-visible:ring-1 focus-visible:ring-primary"
								>
									{annotating ? (
										<span className="relative inline-flex h-2.5 w-2.5">
											<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-over-background-medium opacity-75" />
											<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-over-background-highest" />
										</span>
									) : (
										<span className="text-xs inline-flex h-2.5 w-2.5 rounded-full border border-over-background-medium" />
									)}
									{annotating ? "Annotations ON" : "Annotations OFF"}
								</button>
							</div>
							{annotating && !bannerDismissed && (
								<div
									role="status"
									className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2 text-xs text-over-background-highest"
								>
									<span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
										<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
										<span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
									</span>
									<span className="min-w-0 flex-1 text-xs">{annotationBannerMessage}</span>
									<span className="flex items-center gap-1.5">
										{ANNOTATION_TOOLS.map(tool => {
											const toolActive = annotations.mode === tool.mode
											return (
												<button
													key={tool.mode}
													type="button"
													onClick={() => annotations.toggleMode(tool.mode)}
													title={`${tool.label} tool (shortcut ${tool.shortcut})`}
													className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
														toolActive
															? "border-primary bg-primary/20 text-over-background-highest"
															: "border-background-accent bg-background text-over-background-medium hover:border-primary/60"
													}`}
												>
													<ToolIcon mode={tool.mode} />
													{tool.label}
													<kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-background-accent px-1 text-[10px] font-semibold">
														{tool.shortcut}
													</kbd>
												</button>
											)
										})}
										<button
											type="button"
											onClick={() => handleTabChange("analysis")}
											className="rounded-md border border-background-accent bg-background px-2 py-1 text-xs text-over-background-medium transition-colors hover:border-primary hover:text-primary"
										>
											Turn off
										</button>
										<button
											type="button"
											onClick={() => setBannerDismissed(true)}
											aria-label="Hide this message"
											title="Hide this message"
											className="rounded px-1 text-over-background-low transition-colors hover:text-over-background-highest"
										>
											✕
										</button>
									</span>
								</div>
							)}
							<SessionChart
								onChunkLengths={setChunkLengths}
								channels={channels}
								manifest={manifest}
								sessionFolder={sessionFolder}
								channelNames={channelNames}
								signalKinds={appliedSignalKinds}
								signalAxes={appliedSignalAxes}
								selectedSegment={selectedSegment}
								onWindowRangeChange={setWindowRange}
								annotating={annotating}
								annotationMode={annotations.mode}
								annotations={annotations.annotations}
								labels={labels}
								selectedAnnotationId={annotations.selectedId}
								draft={annotations.draft}
								onChartClick={annotations.handleChartClick}
								onChartDoubleClick={annotations.handleChartDoubleClick}
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
										onSetBounds={annotations.setAnnotationSpan}
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
										sessionFolder={sessionFolder}
										annotations={annotations.annotations}
										labels={labels}
										defaultSegment={selectedSegment}
										defaultRange={windowRange}
										onBusyChange={setExportBusy}
										chunkLengths={chunkLengths}
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

			<ProcessingHelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />

			{confirmLeave && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
					<div
						className="w-full max-w-md rounded-lg p-8 text-over-background-highest-dark shadow-lg"
						style={{ backgroundColor: `${backgroundDarkColor}E6` }}
					>
						<h2 className="mb-4 text-xl font-bold text-over-background-highest-dark">{confirmLeave.title}</h2>
						<p className="mb-4">{confirmLeave.body}</p>
						<div className="flex justify-end gap-4">
							<button
								type="button"
								onClick={() => setConfirmLeave(null)}
								className="rounded-lg uppercase border border-over-background-highest-light dark:border-over-background-highest-dark bg-background-accent-light dark:bg-background-accent-dark px-4 py-2 text-sm font-medium text-over-background-highest-light dark:text-over-background-highest-dark hover:opacity-80"
							>
								{confirmLeave.onConfirm ? "Cancel" : "Close"}
							</button>
							{confirmLeave.onConfirm && (
								<TextButton
									size="base"
									className="!text-sm"
									onClick={() => {
										const action = confirmLeave.onConfirm
										setConfirmLeave(null)
										action?.()
									}}
								>
									{confirmLeave.confirmLabel ?? "Proceed"}
								</TextButton>
							)}
						</div>
					</div>
				</div>
			)}
		</SenseLayout>
	)
}

export default Page
