import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useDarkTheme } from "@scientisst/react-ui/dark-theme"
import resolveConfig from "tailwindcss/resolveConfig"

import tailwindConfig from "../../../tailwind.config"
import CanvasChart, { CanvasAnnotation } from "../charts/CanvasChart"
import { Annotation, AnnotationMode } from "../../hooks/useAnnotations"
import { AnnotationLabel } from "../../utils/annotationLabels"

const fullConfig = resolveConfig(tailwindConfig)
const lineColorLight = (fullConfig.theme as any).colors["primary-light"]
const lineColorDark = (fullConfig.theme as any).colors["primary-dark"]
const outlineColorLight = (fullConfig.theme as any).colors["background-accent-dark"]
const outlineColorDark = (fullConfig.theme as any).colors["background-accent-light"]

type Point = [number, number | null]

const DEFAULT_WINDOW_SECONDS = 30
const MIN_WINDOW_SECONDS = 2
const MAIN_BUCKETS = 1500
const PREFETCH_WINDOWS = 1

function sortChunks(chunks: any[]): any[] {
	return [...chunks].sort((a, b) => {
		const segA = Number(a?.segment) || 0
		const segB = Number(b?.segment) || 0
		if (segA !== segB) return segA - segB
		const ia = Number(String(a?.file).match(/chunk(\d+)/)?.[1] ?? 0)
		const ib = Number(String(b?.file).match(/chunk(\d+)/)?.[1] ?? 0)
		return ia - ib
	})
}

function baseName(file: string): string {
	const parts = file.split(/[\\/]/)
	return parts[parts.length - 1] || file
}

function findChunkRange(
	offsets: number[],
	lens: number[],
	startFrame: number,
	endFrame: number
): [number, number] | null {
	if (offsets.length === 0 || endFrame <= startFrame) return null
	let first = -1
	let last = -1
	for (let i = 0; i < offsets.length; i++) {
		const chunkStart = offsets[i]
		const chunkEnd = chunkStart + lens[i]
		if (chunkEnd <= startFrame) continue
		if (chunkStart >= endFrame) break
		if (first === -1) first = i
		last = i
	}
	return first === -1 ? null : [first, last]
}

function computeTotalSeconds(manifest: any, sampleRate: number): number {
	const segments = Array.isArray(manifest?.segments) ? manifest.segments : []
	let ms = 0
	for (const seg of segments) {
		const start = Number(seg?.startedAt)
		const end = Number(seg?.endedAt)
		if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
			ms += end - start
		}
	}
	return ms > 0 ? ms / 1000 : 0
}

function decimateSlice(
	seg: Float32Array,
	baseFrame: number,
	buckets: number,
	sampleRate: number
): Point[] {
	const n = seg.length
	if (n <= 0) return []

	if (n <= buckets * 2) {
		const out: Point[] = []
		for (let i = 0; i < n; i++) {
			const v = seg[i]
			out.push([(baseFrame + i) / sampleRate, Number.isFinite(v) ? v : null])
		}
		return out
	}

	const bucketSize = n / buckets
	const out: Point[] = []
	for (let b = 0; b < buckets; b++) {
		const s = Math.floor(b * bucketSize)
		const e = Math.floor((b + 1) * bucketSize)
		let min = Infinity
		let max = -Infinity
		let minI = s
		let maxI = s
		let any = false
		for (let i = s; i < e; i++) {
			const v = seg[i]
			if (!Number.isFinite(v)) continue
			any = true
			if (v < min) {
				min = v
				minI = i
			}
			if (v > max) {
				max = v
				maxI = i
			}
		}
		if (!any) continue
		if (minI <= maxI) {
			out.push([(baseFrame + minI) / sampleRate, min])
			out.push([(baseFrame + maxI) / sampleRate, max])
		} else {
			out.push([(baseFrame + maxI) / sampleRate, max])
			out.push([(baseFrame + minI) / sampleRate, min])
		}
	}
	return out
}

const MIN_BRUSH_PX = 18

// Rolls over to h:mm:ss past an hour; `decimals` adds sub-second precision.
function formatTime(seconds: number, decimals = 0): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
	const factor = 10 ** decimals
	const total = Math.round(seconds * factor) / factor
	const s = total % 60
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	const ss = (decimals > 0 ? s.toFixed(decimals) : String(Math.floor(s))).padStart(
		decimals > 0 ? 3 + decimals : 2,
		"0"
	)
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/**
 * Picks label precision from how far apart the ticks actually are. A 2-second
 * window puts several ticks inside the same second, and whole-second labels then
 * repeat ("17:08" twice); sub-second labels keep every tick distinct.
 */
function makeTimeTickFormat(spanSec: number, tickCount: number): (seconds: number) => string {
	const spacing = spanSec > 0 ? spanSec / Math.max(1, tickCount) : 0
	const decimals = spacing <= 0 ? 0 : spacing < 0.1 ? 2 : spacing < 1 ? 1 : 0
	return (seconds: number) => formatTime(seconds, decimals)
}

function parseTimeInput(raw: string): number | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	if (trimmed.includes(":")) {
		const parts = trimmed.split(":")
		if (parts.length !== 2 && parts.length !== 3) return null
		const nums = parts.map(Number)
		if (nums.some(n => !Number.isFinite(n) || n < 0)) return null
		return parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2]
	}
	const n = Number(trimmed)
	return Number.isFinite(n) ? n : null
}

type DragMode = "move" | "resize-left" | "resize-right" | null

interface ChunkCache {
	key: string
	vals: (Record<string, Float32Array> | null)[]
	lens: number[]
	loaded: number
	cumLen: number
}

interface ChannelRowProps {
	label: string
	signalKind?: string
	signalAxis?: string
	windowData: Point[]
	overviewSeries: [number, number][]
	overviewLoading: boolean
	totalSamples: number
	rangeSeconds: number
	windowStartSec: number
	windowSec: number
	winLoading: boolean
	onWindowChange: (startSec: number, secLen: number) => void
	lineColor: string
	outlineColor: string
	annotations: CanvasAnnotation[]
	draftIntervalStart: number | null
	onDataClick?: (x: number, y: number, hitId: string | null) => void
	onDataDoubleClick?: (hitId: string | null) => void
	onAnnotationDragBound?: (id: string, edge: "t0" | "t1" | "point", x: number) => void
	onAnnotationMove?: (id: string, t0: number, t1: number) => void
	placingCursor?: boolean
}

const ChannelRow: React.FC<ChannelRowProps> = ({
	label,
	signalKind,
	signalAxis,
	windowData,
	overviewSeries,
	overviewLoading,
	totalSamples,
	rangeSeconds,
	windowStartSec,
	windowSec,
	winLoading,
	onWindowChange,
	lineColor,
	outlineColor,
	annotations,
	draftIntervalStart,
	onDataClick,
	onDataDoubleClick,
	onAnnotationDragBound,
	onAnnotationMove,
	placingCursor
}) => {
	const winEndSec = windowStartSec + windowSec
	const maxWindowSec = Math.max(MIN_WINDOW_SECONDS, rangeSeconds)
	// Matches the chart's xTicks={6}.
	const xTickFormat = useMemo(() => makeTimeTickFormat(windowSec, 6), [windowSec])
	const trackRef = useRef<HTMLDivElement | null>(null)
	const dragRef = useRef<{
		mode: DragMode
		startX: number
		startWindow: [number, number]
	}>({ mode: null, startX: 0, startWindow: [0, 0] })
	const suppressTrackClickRef = useRef(false)

	const secAtClientX = (clientX: number): number => {
		const el = trackRef.current
		if (!el || rangeSeconds <= 0) return 0
		const rect = el.getBoundingClientRect()
		const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
		return frac * rangeSeconds
	}

	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			const drag = dragRef.current
			if (!drag.mode) return
			const el = trackRef.current
			if (!el) return
			const rect = el.getBoundingClientRect()
			const [s0, w0] = drag.startWindow
			const end0 = s0 + w0

			const deltaSec = ((event.clientX - drag.startX) / rect.width) * rangeSeconds

			if (drag.mode === "move") {
				const s = Math.min(Math.max(0, s0 + deltaSec), Math.max(0, rangeSeconds - w0))
				onWindowChange(s, w0)
			} else if (drag.mode === "resize-left") {
				let s = Math.min(Math.max(0, s0 + deltaSec), end0 - MIN_WINDOW_SECONDS)
				if (end0 - s > maxWindowSec) s = end0 - maxWindowSec
				onWindowChange(s, end0 - s)
			} else if (drag.mode === "resize-right") {
				let e = Math.max(Math.min(rangeSeconds, end0 + deltaSec), s0 + MIN_WINDOW_SECONDS)
				if (e - s0 > maxWindowSec) e = s0 + maxWindowSec
				onWindowChange(s0, e - s0)
			}
		}
		const onUp = () => {
			if (dragRef.current.mode) suppressTrackClickRef.current = true
			dragRef.current.mode = null
		}
		window.addEventListener("pointermove", onMove)
		window.addEventListener("pointerup", onUp)
		return () => {
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerup", onUp)
		}
	}, [rangeSeconds, onWindowChange])

	const startDrag = (mode: DragMode) => (event: React.PointerEvent) => {
		event.preventDefault()
		event.stopPropagation()
		dragRef.current = {
			mode,
			startX: event.clientX,
			startWindow: [windowStartSec, windowSec]
		}
	}

	const step = (direction: -1 | 1) => {
		const next = windowStartSec + direction * windowSec
		onWindowChange(
			Math.min(Math.max(0, next), Math.max(0, rangeSeconds - windowSec)),
			windowSec
		)
	}

	// Editable window-size field
	const [sizeDraft, setSizeDraft] = useState(String(Math.round(windowSec)))
	useEffect(() => {
		setSizeDraft(String(Math.round(windowSec)))
	}, [windowSec])

	const commitSize = (raw: string) => {
		const parsed = Number(raw)
		if (!Number.isFinite(parsed)) {
			setSizeDraft(String(Math.round(windowSec)))
			return
		}
		const clamped = Math.min(
			maxWindowSec,
			Math.max(MIN_WINDOW_SECONDS, parsed)
		)

		const start = Math.min(windowStartSec, Math.max(0, rangeSeconds - clamped))
		onWindowChange(start, clamped)
		setSizeDraft(String(Math.round(clamped)))
	}

	const [startDraft, setStartDraft] = useState(formatTime(windowStartSec))
	useEffect(() => {
		setStartDraft(formatTime(windowStartSec))
	}, [windowStartSec])

	const [endDraft, setEndDraft] = useState(formatTime(winEndSec))
	useEffect(() => {
		setEndDraft(formatTime(winEndSec))
	}, [winEndSec])

	const commitStart = (raw: string) => {
		const parsed = parseTimeInput(raw)
		if (parsed == null) {
			setStartDraft(formatTime(windowStartSec))
			return
		}
		const start = Math.min(Math.max(0, rangeSeconds - windowSec), Math.max(0, parsed))
		onWindowChange(start, windowSec)
		setStartDraft(formatTime(start))
	}

	const commitEnd = (raw: string) => {
		const parsed = parseTimeInput(raw)
		if (parsed == null) {
			setEndDraft(formatTime(winEndSec))
			return
		}
		const end = Math.min(rangeSeconds, Math.max(windowStartSec + MIN_WINDOW_SECONDS, parsed))
		const size = Math.min(maxWindowSec, end - windowStartSec)
		onWindowChange(windowStartSec, size)
		setEndDraft(formatTime(windowStartSec + size))
	}

	const minimapPoints = useMemo(() => {
		if (overviewSeries.length === 0 || totalSamples <= 0) return ""
		let yMin = Infinity
		let yMax = -Infinity
		for (const p of overviewSeries) {
			if (p[1] < yMin) yMin = p[1]
			if (p[1] > yMax) yMax = p[1]
		}
		if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return ""
		const span = yMax - yMin || 1
		let s = ""
		for (const [x, v] of overviewSeries) {
			const px = (x / totalSamples) * 100
			const py = 5 + (1 - (v - yMin) / span) * 90
			s += `${px.toFixed(3)},${py.toFixed(3)} `
		}
		return s.trim()
	}, [overviewSeries, totalSamples])

	const leftPct = rangeSeconds > 0 ? (windowStartSec / rangeSeconds) * 100 : 0
	const widthPct = rangeSeconds > 0 ? (windowSec / rangeSeconds) * 100 : 100

	return (
		<div className="flex w-full flex-col gap-2 rounded-md bg-background-accent p-4">
			<div className="flex items-center gap-3">
				<span className="rounded-md border border-primary px-3 py-1 text-sm">
					{label}
				</span>
				{signalKind && (
					<span className="text-sm font-medium uppercase text-over-background-medium">
						{signalKind}
						{signalKind.toLowerCase() === "acc" && signalAxis && (
							<span className="normal-case"> - {signalAxis.toUpperCase()} axis</span>
						)}
					</span>
				)}
				<span className="ml-auto flex items-center gap-1 text-sm text-over-background-low">
					{winLoading ? (
						"Loading…"
					) : (
						<>
							<input
								type="text"
								inputMode="numeric"
								value={startDraft}
								onChange={event => setStartDraft(event.target.value)}
								onBlur={event => commitStart(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter") {
										event.preventDefault()
										commitStart((event.target as HTMLInputElement).value)
									}
								}}
								className="w-[4.5rem] rounded border border-background-accent-dark bg-background px-1.5 py-0.5 text-center text-sm tabular-nums text-over-background-highest outline-none focus:border-primary dark:border-background-accent-light"
								aria-label="Window start time (m:ss or seconds)"
							/>
							–
							<input
								type="text"
								inputMode="numeric"
								value={endDraft}
								onChange={event => setEndDraft(event.target.value)}
								onBlur={event => commitEnd(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter") {
										event.preventDefault()
										commitEnd((event.target as HTMLInputElement).value)
									}
								}}
								className="w-[4.5rem] rounded border border-background-accent-dark bg-background px-1.5 py-0.5 text-center text-sm tabular-nums text-over-background-highest outline-none focus:border-primary dark:border-background-accent-light"
								aria-label="Window end time (m:ss or seconds)"
							/>
							<span className="tabular-nums"> / {formatTime(rangeSeconds)}</span>
						</>
					)}
				</span>
			</div>

			{winLoading ? (
				<div className="flex h-48 w-full items-center justify-center gap-2">
					<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-background-accent-dark dark:bg-background-accent-light [animation-delay:0ms]" />
					<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-background-accent-dark dark:bg-background-accent-light [animation-delay:200ms]" />
					<span className="h-2.5 w-2.5 animate-pulse rounded-full bg-background-accent-dark dark:bg-background-accent-light [animation-delay:400ms]" />
				</div>
			) : (
				<CanvasChart
					data={windowData}
					xMin={windowStartSec}
					xMax={winEndSec}
					className="h-48 w-full"
					fontFamily="Lexend"
					lineColor={lineColor}
					outlineColor={outlineColor}
					xTicks={5}
					yTicks={5}
					xTickFormat={xTickFormat}
					annotations={annotations}
					draftIntervalStart={draftIntervalStart}
					onDataClick={onDataClick}
					onDataDoubleClick={onDataDoubleClick}
					onAnnotationDragBound={onAnnotationDragBound}
					onAnnotationMove={onAnnotationMove}
					placingCursor={placingCursor}
					topMargin={34}
					rightMargin={16}
					bottomMargin={20}
					leftMargin={12}
				/>
			)}

			<div className="flex items-center justify-between">
				<label className="flex items-center gap-1.5 text-xs tracking-[0.2em] text-over-background-low">
					WINDOW SIZE
					<input
						type="number"
						min={MIN_WINDOW_SECONDS}
						max={Math.round(maxWindowSec)}
						value={sizeDraft}
						onChange={event => setSizeDraft(event.target.value)}
						onBlur={event => commitSize(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault()
								commitSize((event.target as HTMLInputElement).value)
							}
						}}
						className="w-14 rounded border border-background-accent-dark bg-background px-1.5 py-0.5 text-xs tabular-nums tracking-normal text-over-background-highest outline-none focus:border-primary dark:border-background-accent-light"
						aria-label="Window size in seconds"
					/>
					s
				</label>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => step(-1)}
						disabled={windowStartSec <= 0}
						className="rounded px-2 py-0.5 text-xs text-over-background-medium hover:bg-background disabled:opacity-40"
					>
						‹ Prev
					</button>
					<button
						type="button"
						onClick={() => step(1)}
						disabled={winEndSec >= rangeSeconds}
						className="rounded px-2 py-0.5 text-xs text-over-background-medium hover:bg-background disabled:opacity-40"
					>
						Next ›
					</button>
				</div>
			</div>
			<div
				ref={trackRef}
				className="relative h-12 w-full cursor-pointer overflow-hidden rounded-md bg-background"
				onPointerDownCapture={() => {
					suppressTrackClickRef.current = false
				}}
				onClick={event => {
					if (suppressTrackClickRef.current) {
						suppressTrackClickRef.current = false
						return
					}
					if (event.target !== event.currentTarget || rangeSeconds <= 0) return
					const sec = secAtClientX(event.clientX)
					const start = Math.min(Math.max(0, sec - windowSec / 2), Math.max(0, rangeSeconds - windowSec))
					onWindowChange(start, windowSec)
				}}
			>
				{minimapPoints ? (
					<svg
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
					>
						<polyline
							points={minimapPoints}
							fill="none"
							stroke={lineColor}
							strokeWidth={1}
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
				) : (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-over-background-low">
						{overviewLoading ? "Building overview…" : ""}
					</div>
				)}
				{rangeSeconds > 0 &&
					annotations.map(a => {
						const left = (a.t0 / rangeSeconds) * 100
						const width = Math.max(0.5, ((a.t1 - a.t0) / rangeSeconds) * 100)
						return (
							<div
								key={a.id}
								className="pointer-events-none absolute top-0 h-full"
								style={{ left: `${left}%`, width: `${width}%`, backgroundColor: a.color, opacity: 0.75 }}
							/>
						)
					})}
				<div
					className="absolute top-0 h-full cursor-grab touch-none rounded-sm border-2 border-background-accent-dark bg-primary/25 active:cursor-grabbing dark:border-background-accent-light"
					style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: `${MIN_BRUSH_PX}px` }}
					onPointerDown={startDrag("move")}
					title="Drag the middle to move the window; drag an edge to resize it"
				>
					<div
						className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize touch-none rounded-l-sm bg-background-accent-dark/60 dark:bg-background-accent-light/60"
						onPointerDown={startDrag("resize-left")}
						title="Drag to change the window start"
					/>
					<div
						className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize touch-none rounded-r-sm bg-background-accent-dark/60 dark:bg-background-accent-light/60"
						onPointerDown={startDrag("resize-right")}
						title="Drag to change the window end"
					/>
				</div>
			</div>
		</div>
	)
}


interface SessionChartProps {
	channels: string[]
	manifest: any
	sessionFolder: string
	channelNames?: Record<string, string>
	signalKinds?: Record<string, string>
	signalAxes?: Record<string, string>
	selectedSegment?: number
	onWindowRangeChange?: (range: { startSec: number; endSec: number }) => void
	annotating?: boolean
	annotationMode?: AnnotationMode
	annotations?: Annotation[]
	labels?: AnnotationLabel[]
	selectedAnnotationId?: string | null
	draft?: { startSec: number } | null
	onChartClick?: (segment: number, dataX: number, hitId: string | null) => void
	onChartDoubleClick?: (hitId: string | null) => void
	onAnnotationDragBound?: (id: string, edge: "t0" | "t1" | "point", x: number) => void
	onAnnotationMove?: (id: string, t0: number, t1: number) => void
}

const SessionChart: React.FC<SessionChartProps> = ({
	channels,
	manifest,
	sessionFolder,
	channelNames = {},
	signalKinds = {},
	signalAxes = {},
	selectedSegment = 1,
	onWindowRangeChange,
	annotating = false,
	annotationMode = "idle",
	annotations = [],
	labels = [],
	selectedAnnotationId = null,
	draft = null,
	onChartClick,
	onChartDoubleClick,
	onAnnotationDragBound,
	onAnnotationMove
}) => {
	const isDark = useDarkTheme()
	const lineColor = isDark ? lineColorDark : lineColorLight
	const outlineColor = isDark ? outlineColorDark : outlineColorLight

	const labelById = useMemo(() => {
		const map = new Map<number, AnnotationLabel>()
		for (const label of labels) map.set(label.id, label)
		return map
	}, [labels])

	const segmentAnnotations = useMemo<CanvasAnnotation[]>(() => {
		return annotations
			.filter(ann => ann.segment === selectedSegment)
			.map(ann => {
				const label = labelById.get(ann.labelId)
				return {
					id: ann.id,
					t0: ann.t0,
					t1: ann.t1,
					color: label?.color ?? "#888888",
					selected: ann.id === selectedAnnotationId,
					label: label?.name,
					description: label?.description
				}
			})
	}, [annotations, selectedSegment, labelById, selectedAnnotationId])

	const sampleRate = Number(manifest?.sampleRate) || 1000

	const chunks = useMemo(() => {
		const all = Array.isArray(manifest?.chunks) ? sortChunks(manifest.chunks) : []
		return all.filter(chunk => (Number(chunk?.segment) || 1) === selectedSegment)
	}, [manifest, selectedSegment])

	const totalSecondsEstimate = useMemo(() => {
		const segs = Array.isArray(manifest?.segments) ? manifest.segments : []
		const seg = segs[selectedSegment - 1]
		const start = Number(seg?.startedAt)
		const end = Number(seg?.endedAt)
		if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
			return (end - start) / 1000
		}
		return computeTotalSeconds(manifest, sampleRate)
	}, [manifest, sampleRate, selectedSegment])

	const cacheRef = useRef<ChunkCache>({
		key: sessionFolder,
		vals: [],
		lens: [],
		loaded: 0,
		cumLen: 0
	})

	const [windowStartSec, setWindowStartSec] = useState(0)
	const [windowSec, setWindowSec] = useState(DEFAULT_WINDOW_SECONDS)
	const [windowByChannel, setWindowByChannel] = useState<
		Record<string, Point[]>
	>({})
	const [winLoading, setWinLoading] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)

	const [overview, setOverview] = useState<{
		sampleRate: number
		totalSamples: number
		series: Record<string, [number, number][]>
		chunkLengths?: { file: string; frames: number }[]
	} | null>(null)
	const [overviewLoading, setOverviewLoading] = useState(false)

	useEffect(() => {
		cacheRef.current = {
			key: `${sessionFolder}#${selectedSegment}`,
			vals: [],
			lens: [],
			loaded: 0,
			cumLen: 0
		}
		setWindowStartSec(0)
		setWindowSec(
			totalSecondsEstimate > 0 &&
				totalSecondsEstimate < DEFAULT_WINDOW_SECONDS
				? totalSecondsEstimate
				: DEFAULT_WINDOW_SECONDS
		)
		setWindowByChannel({})
		setLoadError(null)
	}, [sessionFolder, selectedSegment, totalSecondsEstimate])

	useEffect(() => {
		let cancelled = false
		if (
			!sessionFolder ||
			chunks.length === 0 ||
			!window.electronAPI?.decimateSession
		) {
			setOverview(null)
			return
		}
		setOverviewLoading(true)
		void (async () => {
			try {
				const result = await window.electronAPI!.decimateSession!(
					sessionFolder,
					2000,
					selectedSegment
				)
				if (!cancelled) setOverview(result ?? null)
			} catch {
				if (!cancelled) setOverview(null)
			} finally {
				if (!cancelled) setOverviewLoading(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [sessionFolder, chunks, selectedSegment])

	const totalSamples = overview?.totalSamples ?? 0
	const overviewSeconds =
		overview && totalSamples > 0
			? totalSamples / (overview.sampleRate || sampleRate)
			: 0
	const rangeSeconds = Math.max(overviewSeconds, totalSecondsEstimate, MIN_WINDOW_SECONDS)
	const rangeRef = useRef(rangeSeconds)
	rangeRef.current = rangeSeconds

	const chunkOffsets = useMemo(() => {
		const lengths = overview?.chunkLengths
		if (!Array.isArray(lengths) || chunks.length === 0) return null
		const byFile = new Map<string, number>()
		for (const entry of lengths) {
			const file = baseName(String(entry?.file ?? ""))
			const frames = Number(entry?.frames)
			if (file && Number.isFinite(frames)) byFile.set(file, frames)
		}
		const offsets: number[] = []
		const lens: number[] = []
		let acc = 0
		for (const chunk of chunks) {
			const len = byFile.get(baseName(String(chunk?.file ?? "")))
			if (len == null) return null
			offsets.push(acc)
			lens.push(len)
			acc += len
		}
		return { offsets, lens, total: acc }
	}, [overview, chunks])

	const onWindowChange = useCallback((startSec: number, secLen: number) => {
		const range = rangeRef.current
		const len = Math.min(Math.max(MIN_WINDOW_SECONDS, secLen), Math.max(MIN_WINDOW_SECONDS, range))
		const start = Math.min(Math.max(0, startSec), Math.max(0, range - len))
		setWindowStartSec(start)
		setWindowSec(len)
	}, [])

	useEffect(() => {
		onWindowRangeChange?.({ startSec: windowStartSec, endSec: windowStartSec + windowSec })
	}, [onWindowRangeChange, windowStartSec, windowSec])

	const viewRef = useRef({ windowStartSec, windowSec, rangeSeconds, annotations, selectedSegment })
	viewRef.current = { windowStartSec, windowSec, rangeSeconds, annotations, selectedSegment }

	useEffect(() => {
		if (!selectedAnnotationId) return
		const { windowStartSec: start, windowSec: sec, rangeSeconds: range, annotations: anns, selectedSegment: seg } = viewRef.current
		const ann = anns.find(a => a.id === selectedAnnotationId && a.segment === seg)
		if (!ann) return
		if (ann.t0 >= start && ann.t1 <= start + sec) return
		const focus = ann.t0
		const maxStart = Math.max(0, range - sec)
		setWindowStartSec(Math.min(Math.max(0, focus - sec / 2), maxStart))
	}, [selectedAnnotationId])

	useEffect(() => {
		if (channels.length === 0 || chunks.length === 0) {
			setWindowByChannel({})
			return
		}
		let cancelled = false
		setLoadError(null)
		const cache = cacheRef.current

		const readChunkInto = async (idx: number): Promise<boolean> => {
			if (cache.vals[idx]) return true
			const data = await window.electronAPI?.readChunkFile?.(
				chunks[idx].file,
				sessionFolder
			)
			if (cancelled) return false
			const frames = Array.isArray(data?.frames)
				? data.frames
				: Array.isArray(data)
				? data
				: []
			const perChannel: Record<string, Float32Array> = {}
			for (const ch of channels) perChannel[ch] = new Float32Array(frames.length)
			for (let i = 0; i < frames.length; i++) {
				const fc = frames[i]?.channels
				for (const ch of channels) {
					const v = Number(fc?.[ch])
					perChannel[ch][i] = Number.isFinite(v) ? v : NaN
				}
			}
			cache.vals[idx] = perChannel
			cache.lens[idx] = frames.length
			return true
		}

		const readUpTo = async (targetEnd: number): Promise<boolean> => {
			while (cache.cumLen < targetEnd && cache.loaded < chunks.length) {
				const idx = cache.loaded
				if (!(await readChunkInto(idx))) return false
				cache.cumLen += cache.lens[idx] ?? 0
				cache.loaded += 1
			}
			return !cancelled
		}

		const buildWindow = (
			ch: string,
			startFrame: number,
			endFrame: number
		): Point[] => {
			const realEnd = Math.min(endFrame, cache.cumLen)
			const sliceLen = Math.max(0, realEnd - startFrame)
			const seg = new Float32Array(sliceLen)
			let chunkStart = 0
			for (let idx = 0; idx < cache.loaded && sliceLen > 0; idx++) {
				const len = cache.lens[idx]
				const chunkEnd = chunkStart + len
				const from = Math.max(startFrame, chunkStart)
				const to = Math.min(realEnd, chunkEnd)
				if (to > from) {
					const src = cache.vals[idx]?.[ch]
					if (src) {
						seg.set(
							src.subarray(from - chunkStart, to - chunkStart),
							from - startFrame
						)
					}
				}
				chunkStart = chunkEnd
			}
			return decimateSlice(seg, startFrame, MAIN_BUCKETS, sampleRate)
		}

		const buildWindowAt = (
			ch: string,
			startFrame: number,
			endFrame: number,
			first: number,
			last: number,
			offsets: number[]
		): Point[] => {
			const sliceLen = Math.max(0, endFrame - startFrame)
			const seg = new Float32Array(sliceLen).fill(NaN)
			for (let idx = first; idx <= last; idx++) {
				const src = cache.vals[idx]?.[ch]
				if (!src) continue
				const chunkStart = offsets[idx]
				const from = Math.max(startFrame, chunkStart)
				const to = Math.min(endFrame, chunkStart + src.length)
				if (to > from) {
					seg.set(
						src.subarray(from - chunkStart, to - chunkStart),
						from - startFrame
					)
				}
			}
			return decimateSlice(seg, startFrame, MAIN_BUCKETS, sampleRate)
		}

		void (async () => {
			try {
				const startFrame = Math.max(0, Math.round(windowStartSec * sampleRate))
				const count = Math.round(windowSec * sampleRate)
				const endFrame = startFrame + count

				if (chunkOffsets) {
					const { offsets, lens, total } = chunkOffsets
					const realEnd = Math.min(endFrame, total)
					const range = findChunkRange(offsets, lens, startFrame, realEnd)
					if (!range) {
						setWindowByChannel({})
						return
					}
					const [first, last] = range

					let missing = false
					for (let i = first; i <= last && !missing; i++) {
						if (!cache.vals[i]) missing = true
					}
					if (missing) setWinLoading(true)
					for (let i = first; i <= last; i++) {
						if (!(await readChunkInto(i))) return
					}

					const next: Record<string, Point[]> = {}
					for (const ch of channels) {
						next[ch] = buildWindowAt(
							ch,
							startFrame,
							realEnd,
							first,
							last,
							offsets
						)
					}
					setWindowByChannel(next)
					setWinLoading(false)

					const pad = count * PREFETCH_WINDOWS
					const warm = findChunkRange(
						offsets,
						lens,
						Math.max(0, startFrame - pad),
						Math.min(total, realEnd + pad)
					)
					if (warm) {
						for (let i = warm[0]; i <= warm[1]; i++) {
							if (cancelled) return
							if (!(await readChunkInto(i))) return
						}
					}
					return
				}

				const needsRead =
					cache.cumLen < endFrame && cache.loaded < chunks.length
				if (needsRead) setWinLoading(true)

				if (!(await readUpTo(endFrame))) return

				const next: Record<string, Point[]> = {}
				for (const ch of channels) next[ch] = buildWindow(ch, startFrame, endFrame)
				setWindowByChannel(next)
				setWinLoading(false)

				// Warm the next window in the background (non-blocking).
				await readUpTo(endFrame + count * PREFETCH_WINDOWS)
			} catch (e) {
				if (!cancelled) {
					setLoadError(e instanceof Error ? e.message : String(e))
					setWindowByChannel({})
				}
			} finally {
				if (!cancelled) setWinLoading(false)
			}
		})()

		return () => {
			cancelled = true
		}
	}, [channels, chunks, windowStartSec, windowSec, sampleRate, chunkOffsets])

	if (loadError) {
		return (
			<div className="flex h-40 items-center justify-center text-sm text-red-500">
				Failed to load signal: {loadError}
			</div>
		)
	}

	return (
		<div className="flex w-full flex-col gap-4">
			{channels.map(ch => (
				<ChannelRow
					key={ch}
					label={channelNames[ch] ? `${channelNames[ch]} (${ch})` : ch}
					signalKind={signalKinds[ch]}
					signalAxis={signalAxes[ch]}
					windowData={windowByChannel[ch] ?? []}
					overviewSeries={overview?.series?.[ch] ?? []}
					overviewLoading={overviewLoading}
					totalSamples={totalSamples}
					rangeSeconds={rangeSeconds}
					windowStartSec={windowStartSec}
					windowSec={windowSec}
					winLoading={winLoading}
					onWindowChange={onWindowChange}
					lineColor={lineColor}
					outlineColor={outlineColor}
					annotations={segmentAnnotations}
					draftIntervalStart={draft ? draft.startSec : null}
					onDataClick={
						annotating && onChartClick
							? (x, _y, hitId) => onChartClick(selectedSegment, x, hitId)
							: undefined
					}
					onDataDoubleClick={annotating ? onChartDoubleClick : undefined}
					onAnnotationDragBound={annotating ? onAnnotationDragBound : undefined}
					onAnnotationMove={annotating ? onAnnotationMove : undefined}
					placingCursor={annotating && (annotationMode === "point" || annotationMode === "interval")}
				/>
			))}
		</div>
	)
}

export default SessionChart
