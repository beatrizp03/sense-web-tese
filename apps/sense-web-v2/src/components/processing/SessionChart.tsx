import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { useDarkTheme } from "@scientisst/react-ui/dark-theme"
import resolveConfig from "tailwindcss/resolveConfig"

import tailwindConfig from "../../../tailwind.config"
import CanvasChart from "../charts/CanvasChart"

const fullConfig = resolveConfig(tailwindConfig)
const lineColorLight = (fullConfig.theme as any).colors["primary-light"]
const lineColorDark = (fullConfig.theme as any).colors["primary-dark"]
// Axes use the opposite background tone: dark gray on light mode, white on dark mode.
const outlineColorLight = (fullConfig.theme as any).colors["background-accent-dark"]
const outlineColorDark = (fullConfig.theme as any).colors["background-accent-light"]

type Point = [number, number | null]

const DEFAULT_WINDOW_SECONDS = 30
const MIN_WINDOW_SECONDS = 2
const MAX_WINDOW_SECONDS = 300
const MAIN_BUCKETS = 1500
// How many windows ahead to warm in the background so "Next" feels instant.
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

/**
 * Min/max-decimate a contiguous sample slice into ~`buckets` buckets, emitting
 * two points (min, max in time order) per bucket. x values are absolute
 * seconds: (baseFrame + i) / sampleRate.
 */
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

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
	const s = Math.floor(seconds % 60)
	const m = Math.floor(seconds / 60)
	return s < 10 ? `${m}:0${s}` : `${m}:${s}`
}

type DragMode = "move" | "resize-left" | "resize-right" | null

// Per-chunk channel values: { [channel]: Float32Array }, read once for all
// channels so a chunk file is never parsed more than once per window.
interface ChunkCache {
	key: string
	vals: (Record<string, Float32Array> | null)[]
	lens: number[]
	loaded: number
	cumLen: number
}

// ---------------------------------------------------------------------------
// A single channel row: header + windowed main chart + minimap navigator.
// Purely presentational — the window state lives in the parent stack so a drag
// on any row updates every row at once.
// ---------------------------------------------------------------------------

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
	outlineColor
}) => {
	const winEndSec = windowStartSec + windowSec
	const trackRef = useRef<HTMLDivElement | null>(null)
	const dragRef = useRef<{
		mode: DragMode
		startX: number
		startWindow: [number, number]
	}>({ mode: null, startX: 0, startWindow: [0, 0] })

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

			if (drag.mode === "move") {
				const deltaSec =
					((event.clientX - drag.startX) / rect.width) * rangeSeconds
				let s = s0 + deltaSec
				s = Math.min(Math.max(0, s), Math.max(0, rangeSeconds - w0))
				onWindowChange(s, w0)
			} else if (drag.mode === "resize-left") {
				const s = Math.min(
					Math.max(0, secAtClientX(event.clientX)),
					end0 - MIN_WINDOW_SECONDS
				)
				onWindowChange(s, Math.min(MAX_WINDOW_SECONDS, end0 - s))
			} else if (drag.mode === "resize-right") {
				const e = Math.max(
					Math.min(rangeSeconds, secAtClientX(event.clientX)),
					s0 + MIN_WINDOW_SECONDS
				)
				onWindowChange(s0, Math.min(MAX_WINDOW_SECONDS, e - s0))
			}
		}
		const onUp = () => {
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
				<span className="ml-auto text-sm text-over-background-low">
					{winLoading ? (
						"Loading…"
					) : (
						<>
							{formatTime(windowStartSec)} – {formatTime(winEndSec)} /{" "}
							{formatTime(rangeSeconds)}
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
					xTicks={6}
					yTicks={5}
					xTickFormat={formatTime}
				/>
			)}

			{/* Window navigator: move / drag edges; updates every row at once */}
			<div className="flex items-center justify-between">
				<span className="text-xs tracking-[0.2em] text-over-background-low">
					WINDOW SIZE ({Math.round(windowSec)}s)
				</span>
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
				className="relative h-12 w-full overflow-hidden rounded-md bg-background"
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
				<div
					className="absolute top-0 h-full cursor-grab touch-none rounded-sm border-2 border-background-accent-dark bg-primary/25 active:cursor-grabbing dark:border-background-accent-light"
					style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
					onPointerDown={startDrag("move")}
				>
					<div
						className="absolute left-0 top-0 h-full w-2 -translate-x-1/2 cursor-ew-resize touch-none"
						onPointerDown={startDrag("resize-left")}
					/>
					<div
						className="absolute right-0 top-0 h-full w-2 translate-x-1/2 cursor-ew-resize touch-none"
						onPointerDown={startDrag("resize-right")}
					/>
				</div>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Stack: owns the shared window + the chunk loader (reads each chunk once for
// all channels) + the whole-session overview, and renders one row per channel.
// ---------------------------------------------------------------------------

interface SessionChartProps {
	channels: string[]
	manifest: any
	sessionFolder: string
	channelNames?: Record<string, string>
	signalKinds?: Record<string, string>
	signalAxes?: Record<string, string>
	selectedSegment?: number
	onWindowRangeChange?: (range: { startSec: number; endSec: number }) => void
}

const SessionChart: React.FC<SessionChartProps> = ({
	channels,
	manifest,
	sessionFolder,
	channelNames = {},
	signalKinds = {},
	signalAxes = {},
	selectedSegment = 1,
	onWindowRangeChange
}) => {
	const isDark = useDarkTheme()
	const lineColor = isDark ? lineColorDark : lineColorLight
	const outlineColor = isDark ? outlineColorDark : outlineColorLight

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
		setWindowSec(DEFAULT_WINDOW_SECONDS)
		setWindowByChannel({})
		setLoadError(null)
	}, [sessionFolder, selectedSegment])

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
	const rangeSeconds = Math.max(
		overviewSeconds,
		totalSecondsEstimate,
		windowStartSec + windowSec,
		MIN_WINDOW_SECONDS
	)

	const onWindowChange = useCallback((startSec: number, secLen: number) => {
		setWindowStartSec(startSec)
		setWindowSec(secLen)
	}, [])

	useEffect(() => {
		onWindowRangeChange?.({ startSec: windowStartSec, endSec: windowStartSec + windowSec })
	}, [onWindowRangeChange, windowStartSec, windowSec])

	useEffect(() => {
		if (channels.length === 0 || chunks.length === 0) {
			setWindowByChannel({})
			return
		}
		let cancelled = false
		setLoadError(null)
		const cache = cacheRef.current

		const readUpTo = async (targetEnd: number): Promise<boolean> => {
			while (cache.cumLen < targetEnd && cache.loaded < chunks.length) {
				const idx = cache.loaded
				const data = await window.electronAPI?.readChunkFile?.(
					chunks[idx].file
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
				cache.cumLen += frames.length
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

		void (async () => {
			try {
				const startFrame = Math.max(0, Math.round(windowStartSec * sampleRate))
				const count = Math.round(windowSec * sampleRate)
				const endFrame = startFrame + count

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
	}, [channels, chunks, windowStartSec, windowSec, sampleRate])

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
				/>
			))}
		</div>
	)
}

export default SessionChart
