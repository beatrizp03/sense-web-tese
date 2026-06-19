import { useCallback, useRef, useState } from "react"

import { ScientISSTFrame } from "@scientisst/sense/future"
import { Canvg } from "canvg"
import * as d3 from "d3"
import FileSaver from "file-saver"
import JsPDF from "jspdf"
import JSZip from "jszip"

import { Annotation } from "./useAnnotations"
import { AnnotationLabel } from "../utils/annotationLabels"

const addSvgToPDF = async (
	pdf: JsPDF,
	svg: SVGSVGElement | string,
	x: number,
	y: number,
	width: number,
	height: number,
	dpi = 300
) => {
	const canvas = document.createElement("canvas")
	const ctx = canvas.getContext("2d")

	const dpmm = dpi / 25.4

	canvas.width = width * dpmm
	canvas.height = height * dpmm
	ctx.clearRect(0, 0, canvas.width, canvas.height)

	const v: Canvg =
		typeof svg !== "string"
			? Canvg.fromString(ctx, svg.outerHTML)
			: await Canvg.from(ctx, svg, {})

	v.resize(width * dpmm, height * dpmm, "xMidYMid meet")
	await v.render()

	const imgData = canvas.toDataURL("image/png")
	pdf.addImage(imgData, "PNG", x, y, width, height)

	canvas.remove()
}

/**
 * Session export logic shared by the acquisition summary page and the processing
 * page. CSV streams every chunk file into one CSV per segment (zipped); PDF
 * renders a ten-second preview per channel via d3 + jsPDF. Both read from the
 * manifest and the Electron file APIs, so they work for live and imported sessions.
 */
export function useSessionExport(manifest: any) {
	const [csvDownloading, setCsvDownloading] = useState(false)
	const [annotationsDownloading, setAnnotationsDownloading] = useState(false)
	const csvExportedRef = useRef(false)
	const pdfExportedRef = useRef(false)

	// Build the per-segment CSV-in-a-zip from the manifest + chunk files. When
	// `annotations` is provided, an extra `annotation` column is appended, with
	// each frame row carrying the label(s) of any annotation anchored to that
	// frame (points cover one frame; intervals cover the whole [t0, t1] span).
	// Returns the zip blob + the first segment's timestamp, or null if the
	// session metadata is incomplete (an alert is shown in that case).
	const buildSessionCsvZip = useCallback(
		async (
			annotations?: Annotation[],
			labels?: AnnotationLabel[]
		): Promise<{ blob: Blob; timestampISO: string } | null> => {
			const channels = manifest.channels || [];
			const deviceType = manifest.deviceType;
			const storedChannelNames = manifest.channelNames || {};
			const sampleRate = manifest.sampleRate;
			const segmentsMeta = manifest.segments || [];

			if (!channels.length || !deviceType || !sampleRate) {
				alert("Missing or incomplete manifest/session metadata.");
				return null;
			}
			if (!manifest.chunks || manifest.chunks.length === 0) {
				alert("No chunk files found in manifest. Export aborted.");
				return null;
			}
			if (deviceType !== "sense" && deviceType !== "maker") {
				alert("Device type not supported yet.");
				return null;
			}

			const withAnnotations = annotations !== undefined
			const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 1000
			const labelById = new Map((labels ?? []).map(l => [l.id, l]))
			const escCsv = (v: string) =>
				/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
			// Anchor annotations to frame ordinals within their segment.
			const annsBySegment = new Map<number, { s: number; e: number; text: string }[]>()
			for (const a of annotations ?? []) {
				const seg = Number(a.segment) || 1
				const s = Math.round(Number(a.t0) * rate)
				const e = Math.round(Number(a.t1) * rate)
				const label = labelById.get(a.labelId)
				const name = label ? label.name : (a.labelId != null ? String(a.labelId) : "")
				const text = a.note ? `${name} (${a.note})` : name
				if (!annsBySegment.has(seg)) annsBySegment.set(seg, [])
				annsBySegment.get(seg)!.push({ s: Math.min(s, e), e: Math.max(s, e), text })
			}

			const zip = new JSZip();
			let firstTimestamp = 0;
			// Group chunk files by segment
			const segmentFiles: Record<string, string[]> = {};
			for (const chunkRec of manifest.chunks) {
				if (!segmentFiles[chunkRec.segment]) segmentFiles[chunkRec.segment] = [];
				segmentFiles[chunkRec.segment].push(chunkRec.file);
			}
			// For each segment, process chunk files sequentially
			for (const [segmentIdx, files] of Object.entries(segmentFiles)) {
				const segment = segmentsMeta.find(s => s.index == segmentIdx);
				const fileContent = [];
				const resolutionBits = [];
				for (let j = 0; j < channels.length; j++) {
					resolutionBits.push(ScientISSTFrame.CHANNEL_SIZES[channels[j]]);
				}
				const timestamp = new Date(segment?.startedAt || 0);
				if (firstTimestamp === 0) {
					firstTimestamp = timestamp.getTime();
				}
				const metadata = {
					Device:
						deviceType === "sense"
							? "ScientISST Sense"
							: "ScientISST Maker",
					Channels: channels,
					"Sampling rate (Hz)": sampleRate,
					"ISO 8601": timestamp.toISOString(),
					Timestamp: timestamp.getTime(),
					"Resolution (bits)": deviceType === "sense" ? resolutionBits : undefined
				};
				fileContent.push("#" + JSON.stringify(metadata, null, null));
				fileContent.push(
					"#NSeq," +
					channels
						.map(channel => {
							const label = storedChannelNames[channel]
							return typeof label === "string" && label.trim().length > 0
								? `${label.trim()} - ${channel}`
								: channel
						})
						.join(",") + (withAnnotations ? ",annotation" : "")
				);
				const segAnns = annsBySegment.get(Number(segmentIdx)) || []
				let frameIdx = 0
				// For each chunk file in this segment, load and stream frames
				for (const chunkFile of files) {
					try {
						// Use Electron API to read chunk file from disk
						const chunkData = await window.electronAPI.readChunkFile?.(chunkFile);
						const frames = Array.isArray(chunkData?.frames) ? chunkData.frames : (Array.isArray(chunkData) ? chunkData : []);
						for (let j = 0; j < frames.length; j++) {
							const frameContent = [];
							frameContent.push(frames[j].sequence);
							for (let k = 0; k < channels.length; k++) {
								frameContent.push(frames[j].channels[channels[k]]);
							}
							if (withAnnotations) {
								let labelText = ""
								if (segAnns.length > 0) {
									const hits: string[] = []
									for (const an of segAnns) {
										if (frameIdx >= an.s && frameIdx <= an.e) hits.push(an.text)
									}
									labelText = hits.join("; ")
								}
								frameContent.push(escCsv(labelText))
							}
							fileContent.push(frameContent.join(","));
							frameIdx++
						}
					} catch (e) {
						console.error("[CSV Export] Failed to read chunk file", chunkFile, e);
					}
				}
				zip.file(`segment_${segmentIdx}.csv`, fileContent.join("\n"));
			}
			if (firstTimestamp === 0) {
				firstTimestamp = new Date().getTime();
			}
			const timestampISO = new Date(firstTimestamp).toISOString();
			const blob = await zip.generateAsync({ type: "blob" })
			return { blob, timestampISO }
		},
		[manifest]
	)

	const convertToCSV = useCallback(async () => {
		if (csvDownloading) return
		setCsvDownloading(true)
		const csvExportStart = Date.now();
		try {
			const result = await buildSessionCsvZip()
			if (!result) return
			FileSaver.saveAs(result.blob, `${result.timestampISO}.zip`);
			csvExportedRef.current = true
			window.electronAPI?.logPerfEvent?.('csv_export', Date.now() - csvExportStart);
		} finally {
			setCsvDownloading(false)
		}
	}, [buildSessionCsvZip, csvDownloading]);

	const convertToCSVWithAnnotations = useCallback(
		async (annotations: Annotation[], labels: AnnotationLabel[]) => {
			if (annotationsDownloading) return
			setAnnotationsDownloading(true)
			const exportStart = Date.now()
			try {
				const result = await buildSessionCsvZip(annotations, labels)
				if (!result) return
				FileSaver.saveAs(result.blob, `${result.timestampISO}_annotations.zip`);
				window.electronAPI?.logPerfEvent?.('csv_annotations_export', Date.now() - exportStart);
			} finally {
				setAnnotationsDownloading(false)
			}
		},
		[buildSessionCsvZip, annotationsDownloading]
	)

	const convertToPDF = useCallback(async () => {
		const pdfExportStart = Date.now();
		const pdf = new JsPDF({
			orientation: "landscape",
			unit: "mm",
			format: "a4",
			floatPrecision: 16,
			putOnlyUsedFonts: true,
			compress: true
		})

		const DOCUMENT_WIDTH = 297
		const DOCUMENT_HEIGHT = 210
		const DOCUMENT_DPI = 400
		const DOCUMENT_MARGIN = 25.4
		const TEXT_PRIMARY: [number, number, number] = [0, 0, 0]
		const TEXT_SECONDARY: [number, number, number] = [138, 138, 138]

		// Add fonts to the PDF document
		const imagineFontFile = await (
			await fetch("/static/imagine.ttf")
		).arrayBuffer()
		const imagineFontBase64 = Buffer.from(
			String.fromCharCode(...new Uint8Array(imagineFontFile)),
			"binary"
		).toString("base64")
		const lexendRegularFontFile = await (
			await fetch("/static/lexend-regular.ttf")
		).arrayBuffer()
		const lexendRegularFontBase64 = Buffer.from(
			String.fromCharCode(...new Uint8Array(lexendRegularFontFile)),
			"binary"
		).toString("base64")
		const lexendSemiBoldFontFile = await (
			await fetch("/static/lexend-semibold.ttf")
		).arrayBuffer()
		const lexendSemiBoldFontBase64 = Buffer.from(
			String.fromCharCode(...new Uint8Array(lexendSemiBoldFontFile)),
			"binary"
		).toString("base64")
		const lexendLightFontFile = await (
			await fetch("/static/lexend-light.ttf")
		).arrayBuffer()
		const lexendLightFontBase64 = Buffer.from(
			String.fromCharCode(...new Uint8Array(lexendLightFontFile)),
			"binary"
		).toString("base64")

		pdf.addFileToVFS("Imagine.ttf", imagineFontBase64)
		pdf.addFont("Imagine.ttf", "Imagine", "normal")
		pdf.addFileToVFS("Lexend-Regular.ttf", lexendRegularFontBase64)
		pdf.addFont("Lexend-Regular.ttf", "Lexend", "regular")
		pdf.addFileToVFS("Lexend-SemiBold.ttf", lexendSemiBoldFontBase64)
		pdf.addFont("Lexend-SemiBold.ttf", "Lexend", "semibold")
		pdf.addFileToVFS("Lexend-Light.ttf", lexendLightFontBase64)
		pdf.addFont("Lexend-Light.ttf", "Lexend", "light")

		// Use manifest as source of truth
		const channels = manifest.channels || [];
		const segmentsMeta = manifest.segments || [];
		const segmentCount = segmentsMeta.length;
		const deviceType = manifest.deviceType;
		const storedChannelNames = manifest.channelNames || {};
		const samplingRate = manifest.sampleRate;
		const timestamp = new Date((segmentsMeta[segmentCount - 1]?.startedAt) || 0);
		const lastSampleNum = segmentsMeta[segmentCount - 1]?.index ?? segmentCount;

		if (!channels.length || !deviceType || !samplingRate) {
			alert("Missing or incomplete manifest/session metadata.");
			return;
		}

		// Load only the last 10 seconds of frames needed for the chart preview
		const svgWidth = samplingRate * 10;
		const frames = await window.electronAPI?.loadPreviewFrames?.(lastSampleNum, svgWidth) ?? [];

		if (!frames || frames.length === 0) {
			alert("No frames found. Export aborted.");
			return;
		}
		if (deviceType !== "sense" && deviceType !== "maker") {
			alert("Device type not supported yet.");
			return;
		}

		const pages = Math.ceil(channels.length / 3)
		for (let page = 0; page < pages; page++) {
			if (page > 0) {
				pdf.addPage()
			}

			const channelsOnPage =
				page < pages - 1 ? 3 : channels.length - 3 * page
			const svgAspectRatio =
				channelsOnPage <= 2 ? 1282 / 180.5 : 1282 / 114.5
			const backgroundAspectRatio =
				channelsOnPage <= 2 ? 1282 / 212 : 1282 / 147
			const smallChart = channelsOnPage > 2

			const svgWidth = samplingRate * 10
			const svgHeight = svgWidth / svgAspectRatio

			// generate svg using d3.js
			const xScale = d3
				.scaleLinear()
				.domain([0, svgWidth - 1])
				.range([0, svgWidth])

			const yScale = d3
				.scaleLinear()
				.domain([0, 4095])
				.range([svgHeight, 0])

			// Header with logo and summary
			await addSvgToPDF(
				pdf,
				"/static/scientisst-break.svg",
				DOCUMENT_MARGIN,
				DOCUMENT_MARGIN,
				25,
				25 / (350 / 111.79),
				DOCUMENT_DPI
			)

			pdf.setTextColor(...TEXT_PRIMARY)
			pdf.setFont("Lexend", "semibold")
			pdf.setFontSize(11.5)
			pdf.text(
				"Acquisition Summary",
				DOCUMENT_WIDTH - DOCUMENT_MARGIN,
				DOCUMENT_MARGIN,
				{
					align: "right",
					baseline: "top"
				}
			)
			pdf.setFont("Lexend", "regular")
			pdf.setFontSize(6)
			pdf.text(
				"Ten-second preview automatically generated\n by SENSE WEB at sense.scientisst.com",
				DOCUMENT_WIDTH - DOCUMENT_MARGIN,
				DOCUMENT_MARGIN + 5,
				{
					align: "right",
					baseline: "top"
				}
			)

			// Fields titles
			pdf.setFont("Lexend", "regular")
			pdf.setFontSize(6)
			pdf.setTextColor(...TEXT_SECONDARY)
			pdf.text("DEVICE", DOCUMENT_MARGIN, DOCUMENT_MARGIN + 15, {
				align: "left",
				baseline: "top"
			})
			pdf.text(
				"SAMPLING FREQUENCY",
				DOCUMENT_MARGIN + 35,
				DOCUMENT_MARGIN + 15,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text("DATE", DOCUMENT_MARGIN + 75, DOCUMENT_MARGIN + 15, {
				align: "left",
				baseline: "top"
			})
			pdf.text("TIME", DOCUMENT_MARGIN + 105, DOCUMENT_MARGIN + 15, {
				align: "left",
				baseline: "top"
			})
			pdf.text(
				"TECHNICIAN",
				DOCUMENT_MARGIN + 135,
				DOCUMENT_MARGIN + 15,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text(
				"PATIENT/CODE",
				DOCUMENT_MARGIN + 175,
				DOCUMENT_MARGIN + 15,
				{
					align: "left",
					baseline: "top"
				}
			)

			// Field values
			pdf.setFontSize(8)
			pdf.setFont("Lexend", "regular")
			pdf.setTextColor(...TEXT_PRIMARY)
			pdf.text("ScientISST CORE", DOCUMENT_MARGIN, DOCUMENT_MARGIN + 18, {
				align: "left",
				baseline: "top"
			})
			pdf.text(
				`${Math.round(samplingRate)} Hz`,
				DOCUMENT_MARGIN + 35,
				DOCUMENT_MARGIN + 18,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text(
				`${new Date(timestamp).toLocaleDateString("en-UK", {
					year: "numeric",
					month: "short",
					day: "numeric"
				})}`,
				DOCUMENT_MARGIN + 75,
				DOCUMENT_MARGIN + 18,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text(
				new Date(timestamp).toLocaleTimeString("en-US", {
					hour: "2-digit",
					minute: "2-digit"
				}),
				DOCUMENT_MARGIN + 105,
				DOCUMENT_MARGIN + 18,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text(
				"Someone's Name",
				DOCUMENT_MARGIN + 135,
				DOCUMENT_MARGIN + 18,
				{
					align: "left",
					baseline: "top"
				}
			)
			pdf.text(
				"Someone's Name or Code",
				DOCUMENT_MARGIN + 175,
				DOCUMENT_MARGIN + 18,
				{
					align: "left",
					baseline: "top"
				}
			)

			let offset = 27
			for (
				let channel = page * 3;
				channel < page * 3 + channelsOnPage;
				channel++
			) {
				pdf.setFont("Lexend", "regular")
				pdf.setFontSize(6)
				pdf.setTextColor(...TEXT_SECONDARY)
				pdf.text(
					storedChannelNames[channels[channel]] ?? channels[channel],
					DOCUMENT_MARGIN,
					DOCUMENT_MARGIN + offset,
					{
						align: "left",
						baseline: "top"
					}
				)

				await addSvgToPDF(
					pdf,
					smallChart
						? "/static/axis_lower.svg"
						: "/static/axis_higher.svg",
					DOCUMENT_MARGIN,
					DOCUMENT_MARGIN + offset + 3.5,
					DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2,
					(DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) /
						backgroundAspectRatio,
					DOCUMENT_DPI
				)
				// Draw x-axis
				pdf.setFont("Lexend", "light")
				pdf.setFontSize(6)
				pdf.setTextColor(...TEXT_SECONDARY)

				for (let i = 0; i < 10; i++) {
					pdf.text(
						i.toString(),
						DOCUMENT_MARGIN +
							((DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) * i) / 10,
						DOCUMENT_MARGIN + offset + (smallChart ? 32.5 : 45.5),
						{
							align: i === 0 ? "left" : "center",
							baseline: "top"
						}
					)
				}

				pdf.text(
					"SECONDS",
					DOCUMENT_WIDTH - DOCUMENT_MARGIN,
					DOCUMENT_MARGIN + offset + (smallChart ? 32.5 : 45.5),
					{
						align: "right",
						baseline: "top"
					}
				)

				const svg = d3
					.create("svg")
					.attr("viewBox", [0, 0, svgWidth, svgHeight])
					.attr("font-family", "Imagine")

				const data = frames
					.slice(-svgWidth)
					.map((frame, i) => [
						i,
						frame.channels[channels[channel]]
					]) as [number, number][]

				svg.append("path")
					.datum(data)
					.attr("fill", "none")
					.attr("stroke", "red")
					.attr("stroke-width", 10)
					.attr(
						"d",
						d3
							.line()
							.x(d => xScale(d[0]))
							.y(d => yScale(d[1]))
					)

				await addSvgToPDF(
					pdf,
					svg.node(),
					DOCUMENT_MARGIN,
					DOCUMENT_MARGIN +
						offset +
						3.5 +
						(DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) / (1282 / 16.25),
					DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2,
					(DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) / svgAspectRatio,
					DOCUMENT_DPI
				)

				svg.remove()

				if (!smallChart) {
					offset += 57
				} else {
					offset += 37
				}
			}

			pdf.setFont("Lexend", "regular")
			pdf.setFontSize(6)
			pdf.setTextColor(...TEXT_SECONDARY)
			pdf.text("OBSERVATIONS", DOCUMENT_MARGIN, DOCUMENT_MARGIN + 140, {
				align: "left",
				baseline: "top"
			})

			const observations =
				"Lorem ipsum dolor sit amet consectetur adipisicing elit. Illum reprehenderit fuga, a, culpa consequatur dolorem molestias magni vero maxime quia suscipit ipsam debitis. Enim alias neque blanditiis soluta nisi odio doloribus ut sit, reiciendis esse, reprehenderit eius hic, repudiandae adipisci natus expedita fuga ad asperiores. Aliquid vero labore quaerat! Consectetur quaerat veritatis, placeat deserunt ullam neque sequi fuga quasi nulla tempora iusto aut? Perferendis id repellat in deleniti molestias. Molestiae alias quo soluta libero qui iste, sed eum magni non voluptas beatae atque dicta accusamus totam. Id ullam reprehenderit, fugit laborum odio dignissimos vel obcaecati minus, qui eos eum provident!"
			const d_obs = pdf.splitTextToSize(
				observations,
				DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2
			)

			pdf.setTextColor(...TEXT_PRIMARY)
			pdf.text(d_obs, DOCUMENT_MARGIN, DOCUMENT_MARGIN + 140 + 3.5, {
				align: "left",
				baseline: "top"
			})

			// Notices
			pdf.setFont("Lexend", "light")
			pdf.setFontSize(6)
			pdf.setTextColor(...TEXT_SECONDARY)
			pdf.text(
				[
					"(C) 2023 ScientISST",
					"Designed by ScientISST at Instituto de Telecomunicações, Lisbon, Portugal"
				],
				DOCUMENT_MARGIN,
				DOCUMENT_HEIGHT - DOCUMENT_MARGIN - 2.5,
				{
					align: "left",
					baseline: "bottom"
				}
			)
			pdf.text(
				[
					"ScientISST hardware and software are not medical devices certified for diagnosis or treatment.",
					"This is PDF Summary is provided to you as is only for research and educational purposes."
				],
				DOCUMENT_WIDTH - DOCUMENT_MARGIN,
				DOCUMENT_HEIGHT - DOCUMENT_MARGIN - 2.5,
				{
					align: "right",
					baseline: "bottom"
				}
			)
		}

		const timestampISO = new Date(timestamp).toISOString()
		pdf.save(`${timestampISO}.pdf`)
		pdfExportedRef.current = true
		window.electronAPI?.logPerfEvent?.('pdf_export', Date.now() - pdfExportStart);
	}, [manifest])

	return { csvDownloading, annotationsDownloading, csvExportedRef, pdfExportedRef, convertToCSV, convertToCSVWithAnnotations, convertToPDF }
}
