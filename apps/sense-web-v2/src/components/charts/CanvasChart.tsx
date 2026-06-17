import { useCallback, useEffect, useRef, useState } from "react"

import clsx from "clsx"
import * as d3 from "d3"

export interface CanvasAnnotation {
	id: string
	type: "point" | "interval"
	startSec: number
	endSec: number
	color: string
	selected?: boolean
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
}

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
	onDataClick
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
			const xAxisHeight = fontSizeScaled + 8 * pixelRatio

			const scaledTopMargin =
				(topMargin ?? fontSizeScaled / 2) * pixelRatio
			const scaledRightMargin =
				(rightMargin ?? fontSizeScaled / 2) * pixelRatio
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

				// Draw intervals first so points always render on top of them.
				const ordered = [...(annotations ?? [])].sort((a, b) =>
					a.type === b.type ? 0 : a.type === "interval" ? -1 : 1
				)
				for (const ann of ordered) {
					const x0 = xScale(ann.startSec)
					const o = ann.selected ? selectedOverhang : overhang
					if (ann.type === "interval") {
						const x1 = xScale(ann.endSec)
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

	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLCanvasElement>) => {
			if (!onDataClick) return
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

			const hitTolerance = 4 * pixelRatio
			let hitId: string | null = null
			// Points render on top of intervals, so they win hit-testing too: test
			// every point first, then fall back to intervals.
			for (let i = geom.annotations.length - 1; i >= 0 && !hitId; i--) {
				const ann = geom.annotations[i]
				if (ann.type !== "point") continue
				const a0 = geom.xScale(ann.startSec)
				const triangle = (ann.selected ? 8 : 6) * pixelRatio
				if (Math.abs(px - a0) <= Math.max(hitTolerance, triangle)) {
					hitId = ann.id
				}
			}
			for (let i = geom.annotations.length - 1; i >= 0 && !hitId; i--) {
				const ann = geom.annotations[i]
				if (ann.type !== "interval") continue
				const a0 = geom.xScale(ann.startSec)
				const a1 = geom.xScale(ann.endSec)
				if (px >= Math.min(a0, a1) && px <= Math.max(a0, a1)) {
					hitId = ann.id
				}
			}

			if (!inPlotY && !hitId) return

			onDataClick(dataX, dataY, hitId)
		},
		[onDataClick, pixelRatio]
	)

	return (
		<div
			ref={setParentElement}
			className={clsx("relative", className)}
			style={style}
		>
			<canvas
				ref={setCanvasElement}
				className="h-auto w-full"
				style={onDataClick ? { cursor: "crosshair" } : undefined}
				onClick={onDataClick ? handleClick : undefined}
			/>
		</div>
	)
}

export default CanvasChart
