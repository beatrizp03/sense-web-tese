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

function hexToRgb(hex: string): [number, number, number] {
	const match = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim())
	if (!match) return [136, 136, 136]
	const int = parseInt(match[1], 16)
	return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

const chunkNumber = (c: any): number =>
	Number(String(c && c.file).match(/chunk(\d+)/)?.[1] ?? 0)

const baseName = (file: string): string => {
	const parts = String(file).split(/[\\/]/)
	return parts[parts.length - 1] || String(file)
}

function buildChunkOffsets(
	segmentChunks: any[],
	chunkLengths?: { file: string; frames: number }[] | null
): { offsets: number[]; lens: number[]; total: number } | null {
	const byFile = new Map<string, number>()
	for (const chunk of segmentChunks) {
		const file = baseName(String(chunk?.file ?? ""))
		const frames = Number(chunk?.frames)
		if (file && Number.isFinite(frames) && frames >= 0) byFile.set(file, frames)
	}
	if (byFile.size < segmentChunks.length) {
		if (!Array.isArray(chunkLengths) || chunkLengths.length === 0) return null
		for (const entry of chunkLengths) {
			const file = baseName(String(entry?.file ?? ""))
			const frames = Number(entry?.frames)
			if (file && Number.isFinite(frames) && !byFile.has(file)) byFile.set(file, frames)
		}
	}
	const offsets: number[] = []
	const lens: number[] = []
	let acc = 0
	for (const chunk of segmentChunks) {
		const len = byFile.get(baseName(String(chunk?.file ?? "")))
		// A chunk missing from the index makes every later offset wrong, so the
		// whole index is abandoned rather than trusted in part.
		if (len == null) return null
		offsets.push(acc)
		lens.push(len)
		acc += len
	}
	return { offsets, lens, total: acc }
}

function decimateByIndex(
	values: number[],
	maxPoints: number
): [number, number][] {
	const n = values.length
	if (n <= maxPoints) {
		return values.map((v, i) => [i, v] as [number, number])
	}
	const bucket = n / maxPoints
	const out: [number, number][] = []
	for (let b = 0; b < maxPoints; b++) {
		const s = Math.floor(b * bucket)
		const e = Math.floor((b + 1) * bucket)
		let mn = Infinity
		let mx = -Infinity
		let mnI = s
		let mxI = s
		for (let i = s; i < e; i++) {
			const v = values[i]
			if (!Number.isFinite(v)) continue
			if (v < mn) {
				mn = v
				mnI = i
			}
			if (v > mx) {
				mx = v
				mxI = i
			}
		}
		if (mn === Infinity) continue
		if (mnI <= mxI) {
			out.push([mnI, mn])
			out.push([mxI, mx])
		} else {
			out.push([mxI, mx])
			out.push([mnI, mn])
		}
	}
	return out
}

function formatClock(seconds: number): string {
	const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
	const total = Math.round(sec * 10) / 10
	const s = total % 60
	const m = Math.floor(total / 60) % 60
	const h = Math.floor(total / 3600)
	const ss = s.toFixed(1).padStart(4, "0")
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

interface SummaryStats {
	mean: number
	median: number
	std: number
	min: number
	max: number
}

export const SUMMARY_STAT_KEYS = ["mean", "median", "std", "min", "max"] as const
export type SummaryStatKey = (typeof SUMMARY_STAT_KEYS)[number]

function statsOf(values: number[]): SummaryStats {
	const v = values.filter(x => Number.isFinite(x))
	const n = v.length
	if (n === 0) return { mean: NaN, median: NaN, std: NaN, min: NaN, max: NaN }
	let sum = 0
	let min = Infinity
	let max = -Infinity
	for (const x of v) {
		sum += x
		if (x < min) min = x
		if (x > max) max = x
	}
	const mean = sum / n
	let sq = 0
	for (const x of v) sq += (x - mean) ** 2
	const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0
	const sorted = [...v].sort((a, b) => a - b)
	const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
	return { mean, median, std, min, max }
}

const fmtStat = (v: unknown): string =>
	typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "--"


const FEATURE_BLOCKS: [library: string, key: string][] = [
	["biosppy", "biosppyFeatures"],
	["neurokit2", "neurokit2Features"],
	["derived", "derivedFeatures"]
]

export interface AnalysisFeatureRow {
	channel: string
	kind: string
	library: string
	feature: string
	value: number | string
}

export async function findAnalysisResult(
	folder: string,
	segment: number,
	startSec: number,
	endSec: number
): Promise<{ result: any; origin: string } | null> {
	const read = window.electronAPI?.readPostHocAnalysisResult
	if (!folder || !read) return null
	const windowSub = `seg${segment}-analysis-window-${Math.round(startSec)}-${Math.round(endSec)}`
	try {
		const windowed = await read(folder, windowSub)
		if (windowed) return { result: windowed, origin: `from window analysis (${windowSub})` }
	} catch {
		// fall through to the full-session run
	}
	try {
		const full = await read(folder, "full-session-analysis")
		if (full) return { result: full, origin: "from full-session analysis" }
	} catch {
		// no analysis available
	}
	return null
}

export function collectAnalysisFeatures(result: any, segment: number): AnalysisFeatureRow[] {
	const segments = Array.isArray(result?.segments) ? result.segments : []
	if (segments.length === 0) return []
	const matching = segments.filter((s: any) => Number(s?.segment) === segment)
	const useSegs = matching.length > 0 ? matching : segments
	const out: AnalysisFeatureRow[] = []
	for (const seg of useSegs) {
		for (const ch of Array.isArray(seg?.channels) ? seg.channels : []) {
			const analysis = ch?.analysis
			if (!analysis || typeof analysis !== "object") continue
			for (const [library, key] of FEATURE_BLOCKS) {
				const block = (analysis as any)[key]
				if (!block || typeof block !== "object") continue
				for (const [feature, value] of Object.entries(block)) {
					if (value === null || value === undefined) continue
					if (typeof value !== "number" && typeof value !== "string") continue
					out.push({
						channel: String(ch?.channel ?? ""),
						kind: typeof ch?.signalKind === "string" ? ch.signalKind : "",
						library,
						feature,
						value
					})
				}
			}
		}
	}
	return out
}

export function useSessionExport(manifest: any, sessionFolder?: string) {
	const [csvDownloading, setCsvDownloading] = useState(false)
	const [annotationsDownloading, setAnnotationsDownloading] = useState(false)
	const [annotatedPdfDownloading, setAnnotatedPdfDownloading] = useState(false)
	const csvExportedRef = useRef(false)
	const pdfExportedRef = useRef(false)
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
			const IO_PORTS = ["I1", "I2", "O1", "O2"]

			const annsBySegment = new Map<
				number,
				{ startFrame: number; t0: number; t1: number; labelId: number; nseq: number | null }[]
			>()
			for (const a of annotations ?? []) {
				const seg = Number(a.segment) || 1
				const t0 = Math.min(Number(a.t0), Number(a.t1))
				const t1 = Math.max(Number(a.t0), Number(a.t1))
				const startFrame = Math.max(0, Math.round(t0 * rate))
				if (!annsBySegment.has(seg)) annsBySegment.set(seg, [])
				annsBySegment.get(seg)!.push({ startFrame, t0, t1, labelId: a.labelId, nseq: null })
			}

			const zip = new JSZip();
			let firstTimestamp = 0;

			const segmentFiles: Record<string, string[]> = {};
			for (const chunkRec of manifest.chunks) {
				if (!segmentFiles[chunkRec.segment]) segmentFiles[chunkRec.segment] = [];
				segmentFiles[chunkRec.segment].push(chunkRec.file);
			}

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
					"Device name": manifest.device || "",
					Firmware: manifest.firmwareVersion || "",
					Channels: channels,
					"Sampling rate (Hz)": sampleRate,
					"ISO 8601": timestamp.toISOString(),
					Timestamp: timestamp.getTime(),
					"Resolution (bits)": deviceType === "sense" ? resolutionBits : undefined
				};
				fileContent.push("#" + JSON.stringify(metadata, null, null));
				fileContent.push(
					"#NSeq," +
					IO_PORTS.join(",") + "," +
					channels
						.map(channel => {
							const label = storedChannelNames[channel]
							return typeof label === "string" && label.trim().length > 0
								? `${label.trim()} - ${channel}`
								: channel
						})
						.join(",")
				);
				const segAnns = annsBySegment.get(Number(segmentIdx)) || []
				let frameIdx = 0
				let lastSeq: number | null = null
				// For each chunk file in this segment, load and stream frames
				for (const chunkFile of files) {
					try {
						// Use Electron API to read chunk file from disk
						const chunkData = await window.electronAPI.readChunkFile?.(chunkFile, sessionFolder);
						const frames = Array.isArray(chunkData?.frames) ? chunkData.frames : (Array.isArray(chunkData) ? chunkData : []);
						for (let j = 0; j < frames.length; j++) {
							const seq = frames[j].__seq ?? frames[j].sequence
							const frameContent: (number | string)[] = [seq];
							for (const port of IO_PORTS) {
								const raw = frames[j].channels?.[port]
								frameContent.push(raw == null ? 0 : Number(raw) ? 1 : 0);
							}
							for (let k = 0; k < channels.length; k++) {
								frameContent.push(frames[j].channels[channels[k]]);
							}
							fileContent.push(frameContent.join(","));
							if (segAnns.length > 0) {
								for (const an of segAnns) {
									if (an.nseq === null && frameIdx >= an.startFrame) an.nseq = seq
								}
							}
							lastSeq = seq
							frameIdx++
						}
					} catch (e) {
						console.error("[CSV Export] Failed to read chunk file", chunkFile, e);
					}
				}
				for (const an of segAnns) if (an.nseq === null) an.nseq = lastSeq
				zip.file(`segment_${segmentIdx}.csv`, fileContent.join("\n"));
			}

			if (withAnnotations) {
				const labelById = new Map((labels ?? []).map(l => [l.id, l]))
				const segs = [...annsBySegment.keys()].sort((a, b) => a - b)
				for (const seg of segs) {
					const anns = (annsBySegment.get(seg) || []).slice().sort((a, b) => a.t0 - b.t0)
					if (anns.length === 0) continue
					const legend: Record<string, string> = {}
					for (const an of anns) {
						const lbl = labelById.get(an.labelId)
						legend[String(an.labelId)] = lbl ? lbl.name : String(an.labelId)
					}
					const segMeta = segmentsMeta.find(s => s.index == seg)
					const segStartedAt = Number(segMeta?.startedAt) || 0
					const annMetadata = {
						Device: deviceType === "sense" ? "ScientISST Sense" : "ScientISST Maker",
						"Device name": manifest.device || "",
						Firmware: manifest.firmwareVersion || "",
						Segment: seg,
						"ISO 8601": new Date(segStartedAt).toISOString(),
						Timestamp: segStartedAt,
						Labels: legend
					}
					const annContent: string[] = []
					annContent.push("#" + JSON.stringify(annMetadata, null, null))
					annContent.push("#NSeq,L,ti,tf")
					for (const an of anns) {
						annContent.push([an.nseq ?? "", an.labelId, an.t0.toFixed(3), an.t1.toFixed(3)].join(","))
					}
					zip.file(`annotations_segment_${seg}.csv`, annContent.join("\n"))
				}
				if (segs.length === 0) {
					zip.file("annotations.csv", "#NSeq,L,ti,tf")
				}
			}

			if (firstTimestamp === 0) {
				firstTimestamp = new Date().getTime();
			}
			const timestampISO = new Date(firstTimestamp).toISOString();
			const blob = await zip.generateAsync({ type: "blob" })
			return { blob, timestampISO }
		},
		[manifest, sessionFolder]
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

	const convertToAnnotatedPDF = useCallback(
		async (opts: {
			segment: number
			startSec: number
			endSec: number
			channels: string[]
			channelNames?: Record<string, string>
			annotations: Annotation[]
			labels: AnnotationLabel[]
			sessionFolder?: string
			includeAnalysis?: boolean
			skipAnnotationTable?: boolean
			observations?: string
			summaryStats?: string[]
			analysisFeatures?: string[]
			chunkLengths?: { file: string; frames: number }[] | null
		}) => {
			if (annotatedPdfDownloading) return
			setAnnotatedPdfDownloading(true)
			const exportStart = Date.now()
			try {
				const channels = opts.channels
				const storedChannelNames = opts.channelNames ?? manifest.channelNames ?? {}
				const storedSignalKinds: Record<string, string> =
					(manifest.channelSignalKinds && typeof manifest.channelSignalKinds === "object"
						? manifest.channelSignalKinds
						: {}) as Record<string, string>
				const storedSignalAxes: Record<string, string> =
					(manifest.channelSignalAxes && typeof manifest.channelSignalAxes === "object"
						? manifest.channelSignalAxes
						: {}) as Record<string, string>
				
				const kindLabel = (ch: string, fallbackKind?: string) => {
					const kind = storedSignalKinds[ch] || fallbackKind || ""
					if (!kind) return ""
					const axis = storedSignalAxes[ch]
					return kind.toLowerCase() === "acc" && axis
						? `ACC ${axis.toUpperCase()}`
						: kind.toUpperCase()
				}
				const channelHeading = (ch: string) => {
					const name = storedChannelNames[ch]
					const inside = [ch, kindLabel(ch) || null].filter(Boolean).join(", ")
					return name ? `${name} (${inside})` : inside
				}
				const deviceType = manifest.deviceType
				const samplingRate = manifest.sampleRate
				const segmentsMeta = manifest.segments || []
				const segment = opts.segment

				if (!channels?.length || !deviceType || !samplingRate) {
					alert("Missing or incomplete manifest/session metadata.")
					return
				}
				if (!manifest.chunks || manifest.chunks.length === 0) {
					alert("No chunk files found in manifest. Export aborted.")
					return
				}
				if (deviceType !== "sense" && deviceType !== "maker") {
					alert("Device type not supported yet.")
					return
				}

				const rate = Number(samplingRate) > 0 ? Number(samplingRate) : 1000
				const startSec = Math.max(0, Math.min(opts.startSec, opts.endSec))
				const endSec = Math.max(opts.startSec, opts.endSec)
				const startFrame = Math.max(0, Math.round(startSec * rate))
				const endFrame = Math.max(startFrame + 1, Math.round(endSec * rate))
				const segMeta = segmentsMeta.find((s: any) => Number(s?.index) === segment) || segmentsMeta[segment - 1]
				const timestamp = new Date(Number(segMeta?.startedAt) || 0)

				const segmentChunks = manifest.chunks
					.filter((c: any) => (Number(c.segment) || 1) === segment)
					.sort((a: any, b: any) => chunkNumber(a) - chunkNumber(b))
				const perChannel: Record<string, number[]> = {}
				for (const ch of channels) perChannel[ch] = []

				const chunkIndex = buildChunkOffsets(segmentChunks, opts.chunkLengths)
				const firstChunk = chunkIndex
					? chunkIndex.offsets.findIndex((start, i) => start + chunkIndex.lens[i] > startFrame)
					: 0
				let idx = chunkIndex && firstChunk > 0 ? chunkIndex.offsets[firstChunk] : 0
				for (let i = Math.max(0, firstChunk); i < segmentChunks.length; i++) {
					if (idx >= endFrame) break
					if (chunkIndex && chunkIndex.offsets[i] >= endFrame) break
					const c = segmentChunks[i]
					const data = await window.electronAPI?.readChunkFile?.(c.file, opts.sessionFolder || sessionFolder)
					const frames = Array.isArray(data?.frames) ? data.frames : (Array.isArray(data) ? data : [])
					for (let j = 0; j < frames.length; j++) {
						if (idx >= endFrame) break
						if (idx >= startFrame) {
							const fc = frames[j]?.channels
							for (const ch of channels) {
								const v = Number(fc?.[ch])
								perChannel[ch].push(Number.isFinite(v) ? v : NaN)
							}
						}
						idx++
					}
				}
				const sampleCount = perChannel[channels[0]]?.length ?? 0
				if (sampleCount === 0) {
					alert("No samples found in the selected range.")
					return
				}

				const labelById = new Map(opts.labels.map(l => [l.id, l]))
				const drawn = opts.annotations
					.filter(a => (Number(a.segment) || 1) === segment && a.t1 >= startSec && a.t0 <= endSec)
					.sort((a, b) => a.t0 - b.t0)

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
				const FOOTER_TEXT = "The PDF continues below. Scroll to see the full content."

				const addPageFooter = () => {
                    pdf.setFont("Lexend", "light")
                    pdf.setFontSize(6)
                    pdf.setTextColor(...TEXT_SECONDARY)
                    pdf.text(FOOTER_TEXT, DOCUMENT_WIDTH / 2, DOCUMENT_HEIGHT - 4.5, {
                        align: "center",
                        baseline: "bottom"
                    })
                }
				// Fonts (same as the CSV/annotated PDF export).
				const loadFont = async (url: string) =>
					Buffer.from(
						String.fromCharCode(...new Uint8Array(await (await fetch(url)).arrayBuffer())),
						"binary"
					).toString("base64")
				pdf.addFileToVFS("Imagine.ttf", await loadFont("/static/imagine.ttf"))
				pdf.addFont("Imagine.ttf", "Imagine", "normal")
				pdf.addFileToVFS("Lexend-Regular.ttf", await loadFont("/static/lexend-regular.ttf"))
				pdf.addFont("Lexend-Regular.ttf", "Lexend", "regular")
				pdf.addFileToVFS("Lexend-SemiBold.ttf", await loadFont("/static/lexend-semibold.ttf"))
				pdf.addFont("Lexend-SemiBold.ttf", "Lexend", "semibold")
				pdf.addFileToVFS("Lexend-Light.ttf", await loadFont("/static/lexend-light.ttf"))
				pdf.addFont("Lexend-Light.ttf", "Lexend", "light")

				const spanSec = endSec - startSec
				const pages = Math.ceil(channels.length / 3)
				for (let page = 0; page < pages; page++) {
					if (page > 0) pdf.addPage()

					const channelsOnPage = page < pages - 1 ? 3 : channels.length - 3 * page
					const svgAspectRatio = channelsOnPage <= 2 ? 1282 / 180.5 : 1282 / 114.5
					const backgroundAspectRatio = channelsOnPage <= 2 ? 1282 / 212 : 1282 / 147
					const smallChart = channelsOnPage > 2

					const svgWidth = 1282
					const svgHeight = svgWidth / svgAspectRatio
					const xScale = d3.scaleLinear().domain([0, Math.max(1, sampleCount - 1)]).range([0, svgWidth])
					const yScale = d3.scaleLinear().domain([0, 4095]).range([svgHeight, 0])

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
					pdf.text("Acquisition Summary", DOCUMENT_WIDTH - DOCUMENT_MARGIN, DOCUMENT_MARGIN, {
						align: "right",
						baseline: "top"
					})
					pdf.setFont("Lexend", "regular")
					pdf.setFontSize(6)
					pdf.text(
						opts.skipAnnotationTable
							? `Segment ${segment} · ${formatClock(startSec)}–${formatClock(endSec)} preview\ngenerated by SENSE WEB at sense.scientisst.com`
							: `Segment ${segment} · ${formatClock(startSec)}–${formatClock(endSec)} preview with ${drawn.length} annotation${drawn.length === 1 ? "" : "s"}\ngenerated by SENSE WEB at sense.scientisst.com`,
						DOCUMENT_WIDTH - DOCUMENT_MARGIN,
						DOCUMENT_MARGIN + 5,
						{ align: "right", baseline: "top" }
					)

					// Fields titles
					pdf.setFont("Lexend", "regular")
					pdf.setFontSize(6)
					pdf.setTextColor(...TEXT_SECONDARY)
					pdf.text("DEVICE", DOCUMENT_MARGIN, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })
					pdf.text("SAMPLING FREQUENCY", DOCUMENT_MARGIN + 35, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })
					pdf.text("DATE", DOCUMENT_MARGIN + 75, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })
					pdf.text("TIME", DOCUMENT_MARGIN + 105, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })
					pdf.text("TECHNICIAN", DOCUMENT_MARGIN + 135, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })
					pdf.text("PATIENT/CODE", DOCUMENT_MARGIN + 175, DOCUMENT_MARGIN + 15, { align: "left", baseline: "top" })

					// Field values
					pdf.setFontSize(8)
					pdf.setFont("Lexend", "regular")
					pdf.setTextColor(...TEXT_PRIMARY)
					pdf.text("ScientISST CORE", DOCUMENT_MARGIN, DOCUMENT_MARGIN + 18, { align: "left", baseline: "top" })
					pdf.text(`${Math.round(rate)} Hz`, DOCUMENT_MARGIN + 35, DOCUMENT_MARGIN + 18, { align: "left", baseline: "top" })
					pdf.text(
						new Date(timestamp).toLocaleDateString("en-UK", { year: "numeric", month: "short", day: "numeric" }),
						DOCUMENT_MARGIN + 75,
						DOCUMENT_MARGIN + 18,
						{ align: "left", baseline: "top" }
					)
					pdf.text(
						new Date(timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
						DOCUMENT_MARGIN + 105,
						DOCUMENT_MARGIN + 18,
						{ align: "left", baseline: "top" }
					)
					pdf.text("Someone's Name", DOCUMENT_MARGIN + 135, DOCUMENT_MARGIN + 18, { align: "left", baseline: "top" })
					pdf.text("Someone's Name or Code", DOCUMENT_MARGIN + 175, DOCUMENT_MARGIN + 18, { align: "left", baseline: "top" })

					let offset = 27
					for (let channel = page * 3; channel < page * 3 + channelsOnPage; channel++) {
						const ch = channels[channel]
						pdf.setFont("Lexend", "regular")
						pdf.setFontSize(6)
						pdf.setTextColor(...TEXT_SECONDARY)
						pdf.text(
							channelHeading(ch),
							DOCUMENT_MARGIN,
							DOCUMENT_MARGIN + offset,
							{ align: "left", baseline: "top" }
						)

						await addSvgToPDF(
							pdf,
							smallChart ? "/static/axis_lower.svg" : "/static/axis_higher.svg",
							DOCUMENT_MARGIN,
							DOCUMENT_MARGIN + offset + 3.5,
							DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2,
							(DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) / backgroundAspectRatio,
							DOCUMENT_DPI
						)

						// Time axis labels across the chosen span.
						pdf.setFont("Lexend", "light")
						pdf.setFontSize(6)
						pdf.setTextColor(...TEXT_SECONDARY)
						const ticks = 6
						for (let i = 0; i <= ticks; i++) {
							pdf.text(
								formatClock(startSec + (spanSec * i) / ticks),
								DOCUMENT_MARGIN + ((DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) * i) / ticks,
								DOCUMENT_MARGIN + offset + (smallChart ? 32.5 : 45.5),
								{ align: i === 0 ? "left" : i === ticks ? "right" : "center", baseline: "top" }
							)
						}
						// The caption names the format rather than a unit, since the axis
						// now reads as a clock and matches the annotations table below it.
						pdf.text(
							startSec + spanSec >= 3600 ? "H:MM:SS.s" : "M:SS.s",
							DOCUMENT_WIDTH - DOCUMENT_MARGIN,
							DOCUMENT_MARGIN + offset + (smallChart ? 36.5 : 49.5),
							{ align: "right", baseline: "top" }
						)

						const plotWidthMm = DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2
						const traceTopMm =
							DOCUMENT_MARGIN + offset + 3.5 + plotWidthMm / (1282 / 16.25)
						const traceHeightMm = plotWidthMm / svgAspectRatio
						for (const [value, yMm] of [
							[4095, traceTopMm],
							[2048, traceTopMm + traceHeightMm / 2],
							[0, traceTopMm + traceHeightMm]
						] as [number, number][]) {
							pdf.text(String(value), DOCUMENT_MARGIN - 1.5, yMm, {
								align: "right",
								baseline: "middle"
							})
						}
						pdf.text("ADC", DOCUMENT_MARGIN - 1.5, traceTopMm - 3.5, {
							align: "right",
							baseline: "middle"
						})

						const svg = d3.create("svg").attr("viewBox", [0, 0, svgWidth, svgHeight] as any).attr("font-family", "Imagine")

						const data = decimateByIndex(perChannel[ch], 2000)

						// Annotation bands (behind the trace).
						for (const a of drawn) {
							if (a.t0 === a.t1) continue
							const color = labelById.get(a.labelId)?.color ?? "#888888"
							const r0 = Math.max(0, Math.round(a.t0 * rate) - startFrame)
							const r1 = Math.min(sampleCount - 1, Math.round(a.t1 * rate) - startFrame)
							const x0 = xScale(r0)
							const x1 = xScale(r1)
							svg.append("rect")
								.attr("x", Math.min(x0, x1))
								.attr("y", 0)
								.attr("width", Math.max(2, Math.abs(x1 - x0)))
								.attr("height", svgHeight)
								.attr("fill", color)
								.attr("fill-opacity", 0.16)
						}

						// Signal trace.
						svg.append("path")
							.datum(data)
							.attr("fill", "none")
							.attr("stroke", "red")
							.attr("stroke-width", 3)
							.attr(
								"d",
								d3
									.line()
									.defined(d => Number.isFinite(d[1]))
									.x(d => xScale(d[0]))
									.y(d => yScale(d[1])) as any
							)

						// Annotation point/edge markers (on top).
						for (const a of drawn) {
							const color = labelById.get(a.labelId)?.color ?? "#888888"
							const edges = a.t0 === a.t1 ? [a.t0] : [a.t0, a.t1]
							for (const t of edges) {
								if (t < startSec || t > endSec) continue
								const x = xScale(Math.round(t * rate) - startFrame)
								svg.append("line")
									.attr("x1", x)
									.attr("x2", x)
									.attr("y1", 0)
									.attr("y2", svgHeight)
									.attr("stroke", color)
									.attr("stroke-width", a.t0 === a.t1 ? 4 : 3)
							}
						}

						await addSvgToPDF(
							pdf,
							svg.node() as SVGSVGElement,
							DOCUMENT_MARGIN,
							DOCUMENT_MARGIN + offset + 3.5 + (DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) / (1282 / 16.25),
							DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2,
							(DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2) / svgAspectRatio,
							DOCUMENT_DPI
						)
						svg.remove()

						offset += smallChart ? 37 : 57
					}

					const footerTop = DOCUMENT_HEIGHT - DOCUMENT_MARGIN - 8
					const observations = (opts.observations ?? "").trim()
					const observationsHeadingY = Math.min(DOCUMENT_MARGIN + offset + 4, footerTop - 8)

					if (observations) {
						pdf.setFont("Lexend", "regular")
						pdf.setFontSize(6)
						pdf.setTextColor(...TEXT_SECONDARY)
						pdf.text("OBSERVATIONS", DOCUMENT_MARGIN, observationsHeadingY, { align: "left", baseline: "top" })

						const observationsBodyY = observationsHeadingY + 3.5
						const lineHeight = 2.6
						const maxLines = Math.max(0, Math.floor((footerTop - observationsBodyY) / lineHeight))
						const wrapped = pdf.splitTextToSize(observations, DOCUMENT_WIDTH - DOCUMENT_MARGIN * 2)
						const shown = wrapped.length > maxLines ? [...wrapped.slice(0, Math.max(0, maxLines - 1)), "..."] : wrapped
						pdf.setTextColor(...TEXT_PRIMARY)
						pdf.text(shown, DOCUMENT_MARGIN, observationsBodyY, { align: "left", baseline: "top" })
					}

					// Notices
					pdf.setFont("Lexend", "light")
					pdf.setFontSize(6)
					pdf.setTextColor(...TEXT_SECONDARY)
					pdf.text(
						["(C) 2023 ScientISST", "Designed by ScientISST at Instituto de Telecomunicações, Lisbon, Portugal"],
						DOCUMENT_MARGIN,
						DOCUMENT_HEIGHT - DOCUMENT_MARGIN - 2.5,
						{ align: "left", baseline: "bottom" }
					)
					pdf.text(
						[
							"ScientISST hardware and software are not medical devices certified for diagnosis or treatment.",
							"This PDF report is provided to you as is only for research and educational purposes."
						],
						DOCUMENT_WIDTH - DOCUMENT_MARGIN,
						DOCUMENT_HEIGHT - DOCUMENT_MARGIN - 2.5,
						{ align: "right", baseline: "bottom" }
					)
					addPageFooter()
				}

				// ---- Annotation table page ----
				if (!opts.skipAnnotationTable) {
					pdf.addPage()
					pdf.setFont("Lexend", "semibold")
					pdf.setFontSize(12)
					pdf.setTextColor(...TEXT_PRIMARY)
					pdf.text("Annotations", DOCUMENT_MARGIN, DOCUMENT_MARGIN, { align: "left", baseline: "top" })

					let ty = DOCUMENT_MARGIN + 8
					if (drawn.length === 0) {
						pdf.setFont("Lexend", "regular")
						pdf.setFontSize(8)
						pdf.setTextColor(...TEXT_SECONDARY)
						pdf.text("No annotations in the selected range.", DOCUMENT_MARGIN, ty, { align: "left", baseline: "top" })
					} else {
						const cols = {
							swatch: DOCUMENT_MARGIN,
							label: DOCUMENT_MARGIN + 7,
							type: DOCUMENT_MARGIN + 48,
							time: DOCUMENT_MARGIN + 72,
							desc: DOCUMENT_MARGIN + 116,
							note: DOCUMENT_MARGIN + 200
						}
						const descW = cols.note - cols.desc - 3
						const noteW = DOCUMENT_WIDTH - DOCUMENT_MARGIN - cols.note - 1

						const drawHeader = () => {
							pdf.setFont("Lexend", "semibold")
							pdf.setFontSize(7)
							pdf.setTextColor(...TEXT_SECONDARY)
							pdf.text("LABEL", cols.label, ty, { align: "left", baseline: "top" })
							pdf.text("TYPE", cols.type, ty, { align: "left", baseline: "top" })
							pdf.text("TIME", cols.time, ty, { align: "left", baseline: "top" })
							pdf.text("DESCRIPTION", cols.desc, ty, { align: "left", baseline: "top" })
							pdf.text("NOTE", cols.note, ty, { align: "left", baseline: "top" })
							ty += 4
							pdf.setDrawColor(210, 210, 210)
							pdf.line(DOCUMENT_MARGIN, ty, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ty)
							ty += 3
						}
						drawHeader()

						for (const a of drawn) {
							const label = labelById.get(a.labelId)
							const name = label?.name ?? String(a.labelId)
							const isPoint = a.t0 === a.t1
							const timeText = isPoint ? formatClock(a.t0) : `${formatClock(a.t0)}–${formatClock(a.t1)}`
							const descLines = pdf.splitTextToSize(label?.description ?? "", descW)
							const noteLines = pdf.splitTextToSize(a.note ?? "", noteW)
							const rowLines = Math.max(1, descLines.length, noteLines.length)
							const rowH = rowLines * 3.4 + 3

							if (ty + rowH > DOCUMENT_HEIGHT - DOCUMENT_MARGIN) {
								pdf.addPage()
								ty = DOCUMENT_MARGIN
								drawHeader()
							}

							const [r, g, b] = hexToRgb(label?.color ?? "#888888")
							pdf.setFillColor(r, g, b)
							pdf.rect(cols.swatch, ty, 3.5, 3.5, "F")

							pdf.setFont("Lexend", "regular")
							pdf.setFontSize(7.5)
							pdf.setTextColor(...TEXT_PRIMARY)
							pdf.text(name, cols.label, ty, { align: "left", baseline: "top" })
							pdf.text(isPoint ? "point" : "interval", cols.type, ty, { align: "left", baseline: "top" })
							pdf.text(timeText, cols.time, ty, { align: "left", baseline: "top" })
							pdf.setTextColor(...TEXT_SECONDARY)
							pdf.text(descLines.length ? descLines : "—", cols.desc, ty, { align: "left", baseline: "top" })
							pdf.text(noteLines.length ? noteLines : "—", cols.note, ty, { align: "left", baseline: "top" })

							ty += rowH
							pdf.setDrawColor(238, 238, 238)
							pdf.line(DOCUMENT_MARGIN, ty - 1.5, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ty - 1.5)
						}
					}
					addPageFooter()
				}

				// ---- Analysis summary ----
				if (opts.includeAnalysis !== false) {
					const folder = opts.sessionFolder || ""
					const found = await findAnalysisResult(folder, segment, startSec, endSec)
					const analysisSrc: any = found?.result ?? null
					const analysisOrigin = found?.origin ?? ""
					const chosenStats: string[] =
						opts.summaryStats && opts.summaryStats.length > 0
							? opts.summaryStats
							: [...SUMMARY_STAT_KEYS]
					const chosenFeatures = new Set(opts.analysisFeatures ?? [])

					let rows: { channel: string; kind: string; summary: SummaryStats }[] = []
					let sourceLabel = ""
					const segArr = Array.isArray(analysisSrc?.segments) ? analysisSrc.segments : []
					if (segArr.length > 0) {
						const matching = segArr.filter((s: any) => Number(s?.segment) === segment)
						const useSegs = matching.length > 0 ? matching : segArr
						rows = useSegs.flatMap((s: any) =>
							(Array.isArray(s?.channels) ? s.channels : []).map((ch: any) => ({
								channel: String(ch?.channel ?? ""),
								kind: typeof ch?.signalKind === "string" ? ch.signalKind : "",
								summary: {
									mean: Number(ch?.summary?.mean),
									median: Number(ch?.summary?.median),
									std: Number(ch?.summary?.std),
									min: Number(ch?.summary?.min),
									max: Number(ch?.summary?.max)
								}
							}))
						)
						sourceLabel = analysisOrigin || "saved analysis"
					}
					if (rows.length === 0) {
						rows = channels.map(ch => ({ channel: ch, kind: "", summary: statsOf(perChannel[ch]) }))
						sourceLabel = "computed now from this window (raw samples)"
					}

					pdf.addPage()
					pdf.setFont("Lexend", "semibold")
					pdf.setFontSize(12)
					pdf.setTextColor(...TEXT_PRIMARY)
					pdf.text("Analysis summary", DOCUMENT_MARGIN, DOCUMENT_MARGIN, { align: "left", baseline: "top" })
					pdf.setFont("Lexend", "regular")
					pdf.setFontSize(7)
					pdf.setTextColor(...TEXT_SECONDARY)
					pdf.text(
						`Segment ${segment} · ${formatClock(startSec)}–${formatClock(endSec)} · ${sourceLabel}`,
						DOCUMENT_MARGIN,
						DOCUMENT_MARGIN + 6,
						{ align: "left", baseline: "top" }
					)

					let ay = DOCUMENT_MARGIN + 12
					const statCols = SUMMARY_STAT_KEYS.filter(key => chosenStats.includes(key))
					const statX = (index: number) => DOCUMENT_MARGIN + 82 + index * (160 / Math.max(1, statCols.length))
					const acols = {
						channel: DOCUMENT_MARGIN,
						kind: DOCUMENT_MARGIN + 50
					}
					const drawAHeader = () => {
						pdf.setFont("Lexend", "semibold")
						pdf.setFontSize(7)
						pdf.setTextColor(...TEXT_SECONDARY)
						pdf.text("CHANNEL", acols.channel, ay, { align: "left", baseline: "top" })
						pdf.text("KIND", acols.kind, ay, { align: "left", baseline: "top" })
						statCols.forEach((key, index) => {
							pdf.text(key.toUpperCase(), statX(index), ay, { align: "left", baseline: "top" })
						})
						ay += 4
						pdf.setDrawColor(210, 210, 210)
						pdf.line(DOCUMENT_MARGIN, ay, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ay)
						ay += 3
					}
					drawAHeader()

					for (const row of rows) {
						if (ay + 6 > DOCUMENT_HEIGHT - DOCUMENT_MARGIN) {
							pdf.addPage()
							ay = DOCUMENT_MARGIN
							drawAHeader()
						}
						const chLabel = storedChannelNames[row.channel]
							? `${storedChannelNames[row.channel]} (${row.channel})`
							: row.channel
						pdf.setFont("Lexend", "regular")
						pdf.setFontSize(7.5)
						pdf.setTextColor(...TEXT_PRIMARY)
						pdf.text(chLabel, acols.channel, ay, { align: "left", baseline: "top" })
						pdf.setTextColor(...TEXT_SECONDARY)
						pdf.text(kindLabel(row.channel, row.kind) || "—", acols.kind, ay, { align: "left", baseline: "top" })
						statCols.forEach((key, index) => {
							pdf.text(fmtStat(row.summary[key]), statX(index), ay, { align: "left", baseline: "top" })
						})
						ay += 6
						pdf.setDrawColor(238, 238, 238)
						pdf.line(DOCUMENT_MARGIN, ay - 2, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ay - 2)
					}

					const featureRows = analysisSrc && chosenFeatures.size > 0
						? collectAnalysisFeatures(analysisSrc, segment).filter(row =>
								chosenFeatures.has(row.feature)
						  )
						: []
					if (featureRows.length > 0) {
						const fcols = {
							channel: DOCUMENT_MARGIN,
							kind: DOCUMENT_MARGIN + 50,
							library: DOCUMENT_MARGIN + 76,
							feature: DOCUMENT_MARGIN + 110,
							value: DOCUMENT_WIDTH - DOCUMENT_MARGIN
						}
						const drawFHeader = () => {
							pdf.setFont("Lexend", "semibold")
							pdf.setFontSize(7)
							pdf.setTextColor(...TEXT_SECONDARY)
							pdf.text("CHANNEL", fcols.channel, ay, { align: "left", baseline: "top" })
							pdf.text("KIND", fcols.kind, ay, { align: "left", baseline: "top" })
							pdf.text("LIBRARY", fcols.library, ay, { align: "left", baseline: "top" })
							pdf.text("FEATURE", fcols.feature, ay, { align: "left", baseline: "top" })
							pdf.text("VALUE", fcols.value, ay, { align: "right", baseline: "top" })
							ay += 4
							pdf.setDrawColor(210, 210, 210)
							pdf.line(DOCUMENT_MARGIN, ay, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ay)
							ay += 3
						}

						ay += 6
						if (ay + 14 > DOCUMENT_HEIGHT - DOCUMENT_MARGIN) {
							pdf.addPage()
							ay = DOCUMENT_MARGIN
						}
						pdf.setFont("Lexend", "semibold")
						pdf.setFontSize(9)
						pdf.setTextColor(...TEXT_PRIMARY)
						pdf.text("Extracted features", DOCUMENT_MARGIN, ay, { align: "left", baseline: "top" })
						ay += 6
						drawFHeader()

						for (const row of featureRows) {
							if (ay + 6 > DOCUMENT_HEIGHT - DOCUMENT_MARGIN) {
								pdf.addPage()
								ay = DOCUMENT_MARGIN
								drawFHeader()
							}
							const chLabel = storedChannelNames[row.channel]
								? `${storedChannelNames[row.channel]} (${row.channel})`
								: row.channel
							pdf.setFont("Lexend", "regular")
							pdf.setFontSize(7.5)
							pdf.setTextColor(...TEXT_PRIMARY)
							pdf.text(chLabel, fcols.channel, ay, { align: "left", baseline: "top" })
							pdf.setTextColor(...TEXT_SECONDARY)
							pdf.text(kindLabel(row.channel, row.kind) || "—", fcols.kind, ay, { align: "left", baseline: "top" })
							pdf.text(row.library, fcols.library, ay, { align: "left", baseline: "top" })
							pdf.text(row.feature, fcols.feature, ay, { align: "left", baseline: "top" })
							pdf.text(
								typeof row.value === "number" ? fmtStat(row.value) : String(row.value),
								fcols.value,
								ay,
								{ align: "right", baseline: "top" }
							)
							ay += 6
							pdf.setDrawColor(238, 238, 238)
							pdf.line(DOCUMENT_MARGIN, ay - 2, DOCUMENT_WIDTH - DOCUMENT_MARGIN, ay - 2)
						}
					}
					addPageFooter()
				}

				const timestampISO = new Date(timestamp).toISOString()
				const segTag = segmentsMeta.length > 1 ? `seg${segment}_` : ""
				const namePrefix = opts.skipAnnotationTable ? "" : "annotation_"
				pdf.save(`${timestampISO}_${namePrefix}${segTag}${Math.round(startSec)}_${Math.round(endSec)}.pdf`)
				window.electronAPI?.logPerfEvent?.(opts.skipAnnotationTable ? 'pdf_range_export' : 'annotated_pdf_export', Date.now() - exportStart)
			} finally {
				setAnnotatedPdfDownloading(false)
			}
		},
		[manifest, annotatedPdfDownloading, sessionFolder]
	)

	const convertToRangePDF = useCallback(
		(opts: {
			segment: number
			startSec: number
			endSec: number
			channels: string[]
			channelNames?: Record<string, string>
		}) =>
			convertToAnnotatedPDF({
				...opts,
				annotations: [],
				labels: [],
				includeAnalysis: false,
				skipAnnotationTable: true
			}),
		[convertToAnnotatedPDF]
	)

	return { csvDownloading, annotationsDownloading, annotatedPdfDownloading, csvExportedRef, pdfExportedRef, convertToCSV, convertToCSVWithAnnotations, convertToAnnotatedPDF, convertToRangePDF }
}
