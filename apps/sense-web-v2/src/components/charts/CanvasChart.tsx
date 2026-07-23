import { useCallback, useEffect, useRef, useState } from "react"

import clsx from "clsx"
import * as d3 from "d3"

export interface CanvasAnnotation {
	id: string
	t0: number
	t1: number
	color: string
	selected?: boolean
	label?: string
	description?: string
}

function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
	if (!match) return hex
	const int = parseInt(match[1], 16)
	const r = (int >> 16) & 255
	const g = (int >> 8) & 255
	const b = int & 255
	return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface CanvasChartProps {
	className?: string
	style?: React.CSSProperties
	data: [number, number | null][]
	xMin?: number | "auto"
	xMax?: number | "auto"
	yMin?: number | "auto"
	yMax?: number | "auto"
	xTicks?: number
	yTicks?: number
	xTickFormat?: (x: number) => string
	yTickFormat?: (y: number) => string
	topMargin?: number
	rightMargin?: number
	bottomMargin?: number
	leftMargin?: number
	fontSize?: number
	fontFamily?: string
	fontWeight?: number
	lineColor?: string
	outlineColor?: string
	annotations?: CanvasAnnotation[]
	draftIntervalStart?: number | null
	draftColor?: string
	onDataClick?: (x: number, y: number, hitId: string | null) => void
	onDataDoubleClick?: (hitId: string | null) => void
	onAnnotationDragBound?: (id: string, edge: "t0" | "t1" | "point", x: number) => void
	onAnnotationMove?: (id: string, t0: number, t1: number) => void
	placingCursor?: boolean
}

const CLICK_MOVE_TOLERANCE_PX = 4
const CLICK_HOLD_TOLERANCE_MS = 500

const CanvasChart: React.FC<CanvasChartProps> = ({
	className,
	style,
	data,
	xMin,
	xMax,
	yMin,
	yMax,
	xTicks,
	yTicks,
	xTickFormat,
	yTickFormat,
	topMargin,
	rightMargin,
	bottomMargin,
	leftMargin,
	fontSize,
	fontFamily,
	fontWeight,
	lineColor,
	outlineColor,
	annotations,
	draftIntervalStart,
	draftColor,
	onDataClick,
	onDataDoubleClick,
	onAnnotationDragBound,
	onAnnotationMove,
	placingCursor
}) => {
	const [parentElement, setParentElement] = useState<HTMLDivElement | null>(
		null
	)
	const [canvasElement, setCanvasElement] =
		useState<HTMLCanvasElement | null>(null)

	const [width, setWidth] = useState(0)
	const [height, setHeight] = useState(0)
	const [pixelRatio, setPixelRatio] = useState(1)

	const geomRef = useRef<{
		xScale: d3.ScaleLinear<number, number>
		yScale: d3.ScaleLinear<number, number>
		plotWidth: number
		plotHeight: number
		leftMargin: number
		topMargin: number
		overhang: number
		annotations: CanvasAnnotation[]
	} | null>(null)

	useEffect(() => {
		if (parentElement) {
			setWidth(parentElement.clientWidth)
			setHeight(parentElement.clientHeight)

			const resizeObserver = new ResizeObserver(() => {
				setWidth(parentElement.clientWidth)
				setHeight(parentElement.clientHeight)
			})

			resizeObserver.observe(parentElement)

			return () => {
				resizeObserver.disconnect()
			}
		}
	}, [parentElement])

	useEffect(() => {
		setPixelRatio(window.devicePixelRatio)

		const resizeObserver = new ResizeObserver(() => {
			setPixelRatio(window.devicePixelRatio)
		})

		resizeObserver.observe(window.document.body)

		return () => {
			resizeObserver.disconnect()
		}
	}, [])

	useEffect(() => {
		if (canvasElement) {
			const scaledWidth = width * pixelRatio
			const scaledHeight = height * pixelRatio

			d3.select(canvasElement)
				.attr("width", scaledWidth)
				.attr("height", scaledHeight)

			const context = canvasElement.getContext("2d")

			if (!context) {
				return
			}

			const fontSizeScaled = (fontSize ?? 16) * pixelRatio
			context.font = `${fontWeight ?? 400} ${fontSizeScaled}px ${
				fontFamily ?? "sans-serif"
			}`

			const X = d3.map(data, d => d[0])
			const Y = d3.map(data, d => d[1])

			const xMinValue =
				xMin === "auto" || xMin === undefined ? d3.min(X) : xMin
			const xMaxValue =
				xMax === "auto" || xMax === undefined ? d3.max(X) : xMax
			const yMinValue =
				yMin === "auto" || yMin === undefined ? d3.min(Y) : yMin
			const yMaxValue =
				yMax === "auto" || yMax === undefined ? d3.max(Y) : yMax

			const yTicksValues = d3.ticks(yMinValue, yMaxValue, yTicks ?? 10)
			const xTicksValues = d3.ticks(xMinValue, xMaxValue, xTicks ?? 10)
			const yAxisWidth =
				d3.max(
					yTicksValues.map(
						y =>
							context.measureText(
								String(yTickFormat ? yTickFormat(y) : y)
							).width
					)
				) +
				8 * pixelRatio
			const xAxisHeight = fontSizeScaled + 10 * pixelRatio

			const xLabelHalfWidth =
				(d3.max(
					xTicksValues.map(
						x => context.measureText(String(xTickFormat ? xTickFormat(x) : x)).width
					)
				) ?? 0) / 2

			const scaledTopMargin =
				(topMargin ?? fontSizeScaled / 2) * pixelRatio
			const scaledRightMargin =
				rightMargin != null
					? rightMargin * pixelRatio
					: Math.max(fontSizeScaled / 2, xLabelHalfWidth + 2 * pixelRatio)
			const scaledBottomMargin =
				(bottomMargin ?? 0) * pixelRatio + xAxisHeight
			const scaledLeftMargin = (leftMargin ?? 0) * pixelRatio + yAxisWidth

			const plotWidth = scaledWidth - scaledLeftMargin - scaledRightMargin
			const plotHeight =
				scaledHeight - scaledTopMargin - scaledBottomMargin

			context.translate(scaledLeftMargin, scaledTopMargin)

			const xScale = d3
				.scaleLinear()
				.domain([xMinValue, xMaxValue])
				.range([0, plotWidth])

			const yScale = d3
				.scaleLinear()
				.domain([yMinValue, yMaxValue])
				.range([plotHeight, 0])

			const lineWidth = 2 * pixelRatio
			const halfLineWidth = lineWidth / 2
			context.lineWidth = lineWidth

			const line = d3
				.line()
				.x(d => xScale(d[0]))
				.y(d => yScale(d[1]))
				.context(context)
				.defined(
					d => d[1] !== null && d[0] >= xMinValue && d[0] <= xMaxValue
				)
				.context(context)

			line(data)
			context.strokeStyle = lineColor ?? "red"
			context.stroke()

			context.strokeStyle = outlineColor ?? "black"

			// Draw y axis
			context.beginPath()
			context.moveTo(0, -halfLineWidth)
			context.lineTo(0, plotHeight + halfLineWidth)
			context.stroke()

			context.textAlign = "right"
			context.textBaseline = "middle"
			context.fillStyle = outlineColor ?? "black"

			for (const yTickValue of yTicksValues) {
				const yTickPosition = yScale(yTickValue)
				context.beginPath()
				context.moveTo(-6 * pixelRatio - halfLineWidth, yTickPosition)
				context.lineTo(-halfLineWidth, yTickPosition)
				context.stroke()

				context.fillText(
					yTickFormat
						? yTickFormat(yTickValue)
						: yTickValue.toString(),
					-halfLineWidth - 8 * pixelRatio,
					yTickPosition
				)
			}

			// Draw x axis
			context.beginPath()
			context.moveTo(-halfLineWidth, plotHeight)
			context.lineTo(plotWidth + halfLineWidth, plotHeight)
			context.stroke()

			context.textAlign = "center"
			context.textBaseline = "top"

			for (const xTickValue of xTicksValues) {
				const xTickPosition = xScale(xTickValue)
				context.beginPath()
				context.moveTo(xTickPosition, plotHeight + halfLineWidth)
				context.lineTo(
					xTickPosition,
					plotHeight + halfLineWidth + 6 * pixelRatio
				)
				context.stroke()

				context.fillText(
					xTickFormat
						? xTickFormat(xTickValue)
						: xTickValue.toString(),
					xTickPosition,
					plotHeight + lineWidth + 8 * pixelRatio
				)
			}

			if ((annotations && annotations.length > 0) || draftIntervalStart != null) {
				const overhang = 15 * pixelRatio
				// The selected annotation rises higher so it stands out from the rest.
				const selectedOverhang = overhang + 12 * pixelRatio
				context.save()
				context.beginPath()
				context.rect(0, -selectedOverhang, plotWidth, plotHeight + selectedOverhang)
				context.clip()

				const isBand = (a: CanvasAnnotation) => a.t0 !== a.t1
				const ordered = [...(annotations ?? [])].sort((a, b) =>
					isBand(a) === isBand(b) ? 0 : isBand(a) ? -1 : 1
				)
				for (const ann of ordered) {
					const x0 = xScale(ann.t0)
					const o = ann.selected ? selectedOverhang : overhang
					if (isBand(ann)) {
						const x1 = xScale(ann.t1)
						const left = Math.min(x0, x1)
						const w = Math.abs(x1 - x0)
						context.fillStyle = hexToRgba(ann.color, ann.selected ? 0.3 : 0.16)
						context.fillRect(left, -o, w, plotHeight + o)
						context.strokeStyle = ann.color
						context.lineWidth = (ann.selected ? 2.5 : 1.5) * pixelRatio
						context.beginPath()
						context.moveTo(left, -o)
						context.lineTo(left, plotHeight)
						context.moveTo(left + w, -o)
						context.lineTo(left + w, plotHeight)
						context.stroke()
					} else {
						context.strokeStyle = ann.color
						context.lineWidth = (ann.selected ? 3 : 2) * pixelRatio
						context.beginPath()
						context.moveTo(x0, -o)
						context.lineTo(x0, plotHeight)
						context.stroke()

						const m = (ann.selected ? 8 : 6) * pixelRatio
						context.fillStyle = ann.color
						context.beginPath()
						context.moveTo(x0 - m, -o)
						context.lineTo(x0 + m, -o)
						context.lineTo(x0, -o + m * 1.5)
						context.closePath()
						context.fill()
					}
				}

				const selForHandles = ordered.find(a => a.selected)
				if (selForHandles) {
					const ho = selectedOverhang
					const hw = 4 * pixelRatio
					const tops = isBand(selForHandles)
						? [xScale(selForHandles.t0), xScale(selForHandles.t1)]
						: [xScale(selForHandles.t0)]
					context.lineWidth = 1.5 * pixelRatio
					for (const hx of tops) {
						context.fillStyle = selForHandles.color
						context.strokeStyle = "#ffffff"
						context.beginPath()
						context.rect(hx - hw, -ho - hw, hw * 2, hw * 2)
						context.fill()
						context.stroke()
					}
				}

				if (draftIntervalStart != null) {
					const dx = xScale(draftIntervalStart)
					context.strokeStyle = draftColor ?? "#9CA3AF"
					context.lineWidth = 1.5 * pixelRatio
					context.setLineDash([4 * pixelRatio, 4 * pixelRatio])
					context.beginPath()
					context.moveTo(dx, -overhang)
					context.lineTo(dx, plotHeight)
					context.stroke()
					context.setLineDash([])
				}

				context.restore()
			}

			geomRef.current = {
				xScale,
				yScale,
				plotWidth,
				plotHeight,
				leftMargin: scaledLeftMargin,
				topMargin: scaledTopMargin,
				overhang: (15 + 12) * pixelRatio,
				annotations: annotations ?? []
			}
		}
	}, [
		data,
		width,
		height,
		pixelRatio,
		canvasElement,
		topMargin,
		rightMargin,
		bottomMargin,
		leftMargin,
		xMin,
		xMax,
		yMin,
		yMax,
		yTicks,
		yTickFormat,
		xTicks,
		xTickFormat,
		fontSize,
		fontWeight,
		fontFamily,
		lineColor,
		outlineColor,
		annotations,
		draftIntervalStart,
		draftColor
	])

	const resizeRef = useRef<
		| { id: string; edge: "t0" | "t1" | "point" }
		| { id: string; edge: "move"; grabX: number; t0: number; t1: number }
		| null
	>(null)
	const justResizedRef = useRef(false)
	const clickTimerRef = useRef<number | null>(null)
	const pressRef = useRef<{ x: number; y: number; time: number } | null>(null)
	const [dragCursor, setDragCursor] = useState<string | null>(null)
	const [hover, setHover] = useState<{ x: number; y: number; label: string; description: string } | null>(null)

	useEffect(
		() => () => {
			if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current)
		},
		[]
	)

	const hitIdAtPx = useCallback(
		(px: number, geom: NonNullable<typeof geomRef.current>): string | null => {
			const hitTolerance = 4 * pixelRatio
			for (let i = geom.annotations.length - 1; i >= 0; i--) {
				const ann = geom.annotations[i]
				if (ann.t0 !== ann.t1) continue
				const a0 = geom.xScale(ann.t0)
				const triangle = (ann.selected ? 8 : 6) * pixelRatio
				if (Math.abs(px - a0) <= Math.max(hitTolerance, triangle)) return ann.id
			}
			for (let i = geom.annotations.length - 1; i >= 0; i--) {
				const ann = geom.annotations[i]
				if (ann.t0 === ann.t1) continue
				const a0 = geom.xScale(ann.t0)
				const a1 = geom.xScale(ann.t1)
				if (px >= Math.min(a0, a1) && px <= Math.max(a0, a1)) return ann.id
			}
			return null
		},
		[pixelRatio]
	)

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLCanvasElement>) => {
			if (justResizedRef.current) {
				justResizedRef.current = false
				return
			}
			if (!onDataClick) return
			if (event.detail > 1) return
			const press = pressRef.current
			pressRef.current = null
			if (press) {
				const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
				if (moved > CLICK_MOVE_TOLERANCE_PX || Date.now() - press.time > CLICK_HOLD_TOLERANCE_MS) return
			}
			const canvas = event.currentTarget
			const geom = geomRef.current
			if (!geom) return

			const rect = canvas.getBoundingClientRect()
			if (rect.width <= 0) return
			const scaleX = canvas.width / rect.width
			const scaleY = canvas.height / rect.height
			const px = (event.clientX - rect.left) * scaleX - geom.leftMargin
			const py = (event.clientY - rect.top) * scaleY - geom.topMargin

			const inX = px >= 0 && px <= geom.plotWidth
			const inPlotY = py >= 0 && py <= geom.plotHeight
			const inOverhangY = py >= -geom.overhang && py < 0
			if (!inX || (!inPlotY && !inOverhangY)) {
				return
			}

			const dataX = geom.xScale.invert(px)
			const dataY = geom.yScale.invert(py)
			const hitId = hitIdAtPx(px, geom)

			if (!inPlotY && !hitId) return

			const deferForDoubleClick =
				hitId != null && !!onDataDoubleClick && draftIntervalStart == null
			if (deferForDoubleClick) {
				if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current)
				clickTimerRef.current = window.setTimeout(() => {
					clickTimerRef.current = null
					onDataClick(dataX, dataY, hitId)
				}, 220)
				return
			}

			onDataClick(dataX, dataY, hitId)
		},
		[onDataClick, onDataDoubleClick, draftIntervalStart, hitIdAtPx]
	)

	const handleDoubleClick = useCallback(
		(event: React.MouseEvent<HTMLCanvasElement>) => {
			if (!onDataDoubleClick) return
			if (clickTimerRef.current) {
				window.clearTimeout(clickTimerRef.current)
				clickTimerRef.current = null
			}
			const canvas = event.currentTarget
			const geom = geomRef.current
			if (!geom) return
			const rect = canvas.getBoundingClientRect()
			if (rect.width <= 0) return
			const scaleX = canvas.width / rect.width
			const px = (event.clientX - rect.left) * scaleX - geom.leftMargin
			const hitId = hitIdAtPx(px, geom)
			if (hitId) onDataDoubleClick(hitId)
		},
		[onDataDoubleClick, hitIdAtPx]
	)

	// Map a pointer event's clientX to a data-x using the current geometry.
	const clientXToData = (clientX: number, canvas: HTMLCanvasElement): number | null => {
		const geom = geomRef.current
		const rect = canvas.getBoundingClientRect()
		if (!geom || rect.width <= 0) return null
		const scaleX = canvas.width / rect.width
		const px = (clientX - rect.left) * scaleX - geom.leftMargin
		return geom.xScale.invert(px)
	}

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			pressRef.current = { x: event.clientX, y: event.clientY, time: Date.now() }
			if (!onAnnotationDragBound && !onAnnotationMove) return
			const geom = geomRef.current
			const canvas = event.currentTarget
			const rect = canvas.getBoundingClientRect()
			if (!geom || rect.width <= 0) return
			const scaleX = canvas.width / rect.width
			const px = (event.clientX - rect.left) * scaleX - geom.leftMargin
			const sel = geom.annotations.find(a => a.selected)
			if (!sel) return
			const grab = 8 * pixelRatio
			let edge: "t0" | "t1" | "point" | null = null
			if (sel.t0 === sel.t1) {
				if (Math.abs(px - geom.xScale(sel.t0)) <= grab) edge = "point"
			} else if (Math.abs(px - geom.xScale(sel.t0)) <= grab) {
				edge = "t0"
			} else if (Math.abs(px - geom.xScale(sel.t1)) <= grab) {
				edge = "t1"
			}
			if (edge && onAnnotationDragBound) {
				resizeRef.current = { id: sel.id, edge }
			} else if (onAnnotationMove && sel.t0 !== sel.t1) {
				// Interior of a selected interval (between the edge grab zones): move it.
				const left = geom.xScale(Math.min(sel.t0, sel.t1))
				const right = geom.xScale(Math.max(sel.t0, sel.t1))
				if (px <= left + grab || px >= right - grab) return
				resizeRef.current = {
					id: sel.id,
					edge: "move",
					grabX: geom.xScale.invert(px),
					t0: sel.t0,
					t1: sel.t1
				}
			} else {
				return
			}
			try {
				canvas.setPointerCapture(event.pointerId)
			} catch {
				/* ignore */
			}
			event.preventDefault()
		},
		[onAnnotationDragBound, onAnnotationMove, pixelRatio]
	)

	const findAnnotationAt = (clientX: number, canvas: HTMLCanvasElement): CanvasAnnotation | null => {
		const geom = geomRef.current
		const rect = canvas.getBoundingClientRect()
		if (!geom || rect.width <= 0) return null
		const scaleX = canvas.width / rect.width
		const px = (clientX - rect.left) * scaleX - geom.leftMargin
		const tol = 4 * pixelRatio
		for (let i = geom.annotations.length - 1; i >= 0; i--) {
			const ann = geom.annotations[i]
			if (ann.t0 !== ann.t1) continue
			const tri = (ann.selected ? 8 : 6) * pixelRatio
			if (Math.abs(px - geom.xScale(ann.t0)) <= Math.max(tol, tri)) return ann
		}
		for (let i = geom.annotations.length - 1; i >= 0; i--) {
			const ann = geom.annotations[i]
			if (ann.t0 === ann.t1) continue
			const a0 = geom.xScale(ann.t0)
			const a1 = geom.xScale(ann.t1)
			if (px >= Math.min(a0, a1) && px <= Math.max(a0, a1)) return ann
		}
		return null
	}

	/**
	 * What a press at this position would do to the selected annotation, so the
	 * cursor can say whether it will resize an edge or move the whole interval.
	 * Mirrors the hit-testing in handlePointerDown.
	 */
	const dragCursorAt = (clientX: number, canvas: HTMLCanvasElement): string | null => {
		if (!onAnnotationDragBound && !onAnnotationMove) return null
		const geom = geomRef.current
		const rect = canvas.getBoundingClientRect()
		if (!geom || rect.width <= 0) return null
		const sel = geom.annotations.find(a => a.selected)
		if (!sel) return null
		const px = (clientX - rect.left) * (canvas.width / rect.width) - geom.leftMargin
		const grab = 8 * pixelRatio
		if (sel.t0 === sel.t1) {
			return Math.abs(px - geom.xScale(sel.t0)) <= grab ? "ew-resize" : null
		}
		if (Math.abs(px - geom.xScale(sel.t0)) <= grab || Math.abs(px - geom.xScale(sel.t1)) <= grab) {
			return onAnnotationDragBound ? "ew-resize" : null
		}
		const left = geom.xScale(Math.min(sel.t0, sel.t1))
		const right = geom.xScale(Math.max(sel.t0, sel.t1))
		if (onAnnotationMove && px > left + grab && px < right - grab) return "grab"
		return null
	}

	const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		const r = resizeRef.current
		if (r) {
			const x = clientXToData(event.clientX, event.currentTarget)
			if (x == null) return
			if (r.edge === "move") {
				const delta = x - r.grabX
				onAnnotationMove?.(r.id, r.t0 + delta, r.t1 + delta)
			} else {
				onAnnotationDragBound?.(r.id, r.edge, x)
			}
			return
		}
		setDragCursor(dragCursorAt(event.clientX, event.currentTarget))
		const hit = findAnnotationAt(event.clientX, event.currentTarget)
		if (hit && (hit.label || hit.description)) {
			const rect = event.currentTarget.getBoundingClientRect()
			setHover({
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
				label: hit.label ?? "",
				description: hit.description ?? ""
			})
		} else {
			setHover(prev => (prev ? null : prev))
		}
	}

	const endResize = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
		if (!resizeRef.current) return
		resizeRef.current = null
		justResizedRef.current = true
		try {
			event.currentTarget.releasePointerCapture(event.pointerId)
		} catch {
			/* ignore */
		}
	}, [])

	return (
		<div
			ref={setParentElement}
			className={clsx("relative", className)}
			style={style}
		>
			<canvas
				ref={setCanvasElement}
				className="h-auto w-full"
				style={dragCursor ? { cursor: dragCursor } : placingCursor ? { cursor: "crosshair" } : undefined}
				onClick={onDataClick ? handleClick : undefined}
				onDoubleClick={onDataDoubleClick ? handleDoubleClick : undefined}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={onAnnotationDragBound || onAnnotationMove ? endResize : undefined}
				onPointerCancel={onAnnotationDragBound || onAnnotationMove ? endResize : undefined}
				onPointerLeave={() => {
					setHover(null)
					setDragCursor(null)
				}}
			/>
			{hover && (
				<div
					className="pointer-events-none absolute z-20 max-w-[16rem] rounded-md border border-background-accent bg-background px-2 py-1 text-xs shadow-lg"
					style={{ left: hover.x + 12, top: hover.y + 12 }}
				>
					{hover.label && <span className="font-semibold text-xs text-over-background-highest">{hover.label}</span>}
					{hover.description && (
						<span className="block text-xs text-over-background-medium">{hover.description}</span>
					)}
				</div>
			)}
		</div>
	)
}

export default CanvasChart
