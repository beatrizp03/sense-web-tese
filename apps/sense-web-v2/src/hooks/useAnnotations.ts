import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AnnotationLabel, sanitizeLabels } from "../utils/annotationLabels"

export type AnnotationType = "point" | "interval"
export type AnnotationMode = "idle" | "point" | "interval"
export type AnnotationScope = "channel" | "record"
export type AnnotationSource = "manual" | "auto"

export interface Annotation {
	id: string
	scope: AnnotationScope
	channel: string | null
	segment: number
	t0: number
	t1: number
	labelId: number
	note: string
	source: AnnotationSource
	creator: string
	createdAt: string
	updatedAt: string
}

export const annotationKind = (a: { t0: number; t1: number }): AnnotationType =>
	a.t0 === a.t1 ? "point" : "interval"

const CREATOR = "user"
const nowIso = () => new Date().toISOString()

const commitTagToAction = (tag: string): string => {
	switch (tag.split(":")[0]) {
		case "add":
			return "create"
		case "del":
			return "remove"
		case "clear":
			return "clear"
		case "note":
			return "note"
		case "label":
			return "relabel"
		case "bounds":
		case "move":
			return "edit"
		default:
			return "edit"
	}
}

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now())

function makeAnnotation(segment: number, t0: number, t1: number, labelId: number): Annotation {
	const now = nowIso()
	return {
		id: newId(),
		scope: "channel",
		channel: null,
		segment,
		t0,
		t1,
		labelId,
		note: "",
		source: "manual",
		creator: CREATOR,
		createdAt: now,
		updatedAt: now
	}
}

type SerializedAnnotation = Omit<Annotation, "t0" | "t1"> & {
	ti: number
	tf: number
	sample: number
	sampleEnd: number
	atStartMs: number | null
	atEndMs: number | null
}

interface AnnotationsFile {
	version: number
	savedAt: string
	annotations: SerializedAnnotation[]
	labels?: AnnotationLabel[]
	segmentLabels?: Record<number, number>
}

interface LabelsFile {
	schemaVersion?: number
	savedAt?: string
	labels?: AnnotationLabel[]
}

function sanitizeSegmentLabels(value: unknown): Record<number, number> {
	if (!value || typeof value !== "object") return {}
	const out: Record<number, number> = {}
	for (const [seg, labelId] of Object.entries(value as Record<string, unknown>)) {
		const s = Number(seg)
		const id = Number(labelId)
		if (Number.isFinite(s) && Number.isFinite(id)) out[s] = id
	}
	return out
}

function newId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID()
	}
	return `ann-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

function sanitizeAnnotations(value: unknown): Annotation[] {
	if (!Array.isArray(value)) return []
	const out: Annotation[] = []
	for (const item of value) {
		if (!item || typeof item !== "object") continue
		const raw = item as Record<string, unknown>
		const t0 = Number(raw.ti ?? raw.t0 ?? raw.startSec)
		const t1raw = Number(raw.tf ?? raw.t1 ?? raw.endSec ?? raw.ti ?? raw.t0 ?? raw.startSec)
		const labelId = Number(raw.labelId)
		if (!Number.isFinite(t0) || !Number.isFinite(labelId)) continue
		const t1 = Number.isFinite(t1raw) ? Math.max(t0, t1raw) : t0
		const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : ""
		out.push({
			id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
			scope: raw.scope === "record" ? "record" : "channel",
			channel: typeof raw.channel === "string" ? raw.channel : null,
			segment: Number(raw.segment) || 1,
			t0,
			t1,
			labelId,
			note: typeof raw.note === "string" ? raw.note : "",
			source: raw.source === "auto" ? "auto" : "manual",
			creator: typeof raw.creator === "string" ? raw.creator : CREATOR,
			createdAt,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt
		})
	}
	return out
}

interface UseAnnotationsOptions {
	sessionFolder: string
	enabled: boolean
	labels: AnnotationLabel[]
	sampleRate?: number
	segments?: { index: number; startedAt?: number }[]
}

export function useAnnotations({ sessionFolder, enabled, labels, sampleRate, segments }: UseAnnotationsOptions) {
	const [annotations, setAnnotations] = useState<Annotation[]>([])
	const [activeLabelId, setActiveLabelId] = useState<number | null>(null)
	const [mode, setMode] = useState<AnnotationMode>("idle")
	const [draft, setDraft] = useState<{ startSec: number } | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [sessionLabels, setSessionLabels] = useState<AnnotationLabel[] | null>(null)
	const [segmentLabels, setSegmentLabels] = useState<Record<number, number>>({})

	const annotationsRef = useRef(annotations)
	useEffect(() => {
		annotationsRef.current = annotations
	}, [annotations])

	// ---- Undo / redo --------------------------------------------------------
	const historyRef = useRef<{ past: Annotation[][]; future: Annotation[][] }>({ past: [], future: [] })
	const lastEditRef = useRef<{ tag: string; at: number }>({ tag: "", at: 0 })
	const [canUndo, setCanUndo] = useState(false)
	const [canRedo, setCanRedo] = useState(false)

	const resetHistory = useCallback(() => {
		historyRef.current = { past: [], future: [] }
		lastEditRef.current = { tag: "", at: 0 }
		setCanUndo(false)
		setCanRedo(false)
	}, [])

	const snap = useCallback(
		(t: number) => {
			const rate = Number(sampleRate)
			return rate > 0 ? Math.round(t * rate) / rate : t
		},
		[sampleRate]
	)

	const logAnnotationEvent = useCallback(
		(action: string, durationMs: number, opts?: { count?: number; detail?: Record<string, unknown> }) => {
			if (!sessionFolder) return
			try {
				window.electronAPI?.logAnnotationEvent?.({
					sessionFolder,
					action,
					durationMs,
					annotationCount: opts?.count ?? annotationsRef.current.length,
					detail: opts?.detail
				})
			} catch {
				/* logging must never break annotation editing */
			}
		},
		[sessionFolder]
	)

	const HISTORY_LIMIT = 100
	const commit = useCallback((tag: string, updater: (list: Annotation[]) => Annotation[]) => {
		const t0 = nowMs()
		const prev = annotationsRef.current
		const next = updater(prev)
		if (next === prev) return
		const now = Date.now()
		const h = historyRef.current
		const last = lastEditRef.current
		const coalesce = tag !== "" && tag === last.tag && now - last.at < 700
		if (!coalesce) {
			h.past.push(prev)
			if (h.past.length > HISTORY_LIMIT) h.past.shift()
		}
		h.future = []
		lastEditRef.current = { tag, at: now }
		annotationsRef.current = next
		setAnnotations(next)
		setDirty(true)
		setCanUndo(true)
		setCanRedo(false)
		const action = commitTagToAction(tag)
		const prefix = tag.split(":")[0]
		const id = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : ""
		let detail: Record<string, unknown> | undefined
		if (action === "clear") {
			detail = { removed: prev.length - next.length }
		} else if (id) {
			const ann = next.find(a => a.id === id) ?? prev.find(a => a.id === id)
			detail = ann ? { id: ann.id, labelId: ann.labelId, segment: ann.segment } : { id }
			if (action === "edit") detail.op = prefix === "move" ? "move" : "resize"
		}
		logAnnotationEvent(action, nowMs() - t0, { count: next.length, detail })
	}, [logAnnotationEvent])

	const undo = useCallback(() => {
		const h = historyRef.current
		const prev = h.past.pop()
		if (prev === undefined) return
		h.future.push(annotationsRef.current)
		lastEditRef.current = { tag: "", at: 0 }
		annotationsRef.current = prev
		setAnnotations(prev)
		setSelectedId(null)
		setDraft(null)
		setDirty(true)
		setCanUndo(h.past.length > 0)
		setCanRedo(true)
	}, [])

	const redo = useCallback(() => {
		const h = historyRef.current
		const next = h.future.pop()
		if (next === undefined) return
		h.past.push(annotationsRef.current)
		lastEditRef.current = { tag: "", at: 0 }
		annotationsRef.current = next
		setAnnotations(next)
		setSelectedId(null)
		setDraft(null)
		setDirty(true)
		setCanUndo(true)
		setCanRedo(h.future.length > 0)
	}, [])

	const effectiveLabels = useMemo(() => sessionLabels ?? labels, [sessionLabels, labels])

	const channelLabels = useMemo(
		() => effectiveLabels.filter(l => l.appliesTo === "channel" && !l.retired),
		[effectiveLabels]
	)

	useEffect(() => {
		if (activeLabelId == null && channelLabels.length > 0) {
			setActiveLabelId(channelLabels[0].id)
		}
	}, [activeLabelId, channelLabels])

	const activeLabel = useMemo(
		() => effectiveLabels.find(l => l.id === activeLabelId) ?? null,
		[effectiveLabels, activeLabelId]
	)

	const applyFileMeta = useCallback((data: AnnotationsFile | null, labelsFile: LabelsFile | null) => {
		const sidecar = labelsFile?.labels
		const snapshot = data?.labels
		const arr =
			Array.isArray(sidecar) && sidecar.length > 0
				? sidecar
				: Array.isArray(snapshot) && snapshot.length > 0
					? snapshot
					: null
		setSessionLabels(arr ? sanitizeLabels(arr) : null)
		setSegmentLabels(sanitizeSegmentLabels(data?.segmentLabels))
	}, [])

	const readSidecars = useCallback(async (folder: string) => {
		const [data, labelsFile] = await Promise.all([
			window.electronAPI!.readSessionAnnotations!(folder) as Promise<AnnotationsFile | null>,
			(window.electronAPI?.readSessionLabels?.(folder) ?? Promise.resolve(null)) as Promise<LabelsFile | null>
		])
		return { data, labelsFile }
	}, [])

	// ---- Load on session change --------------------------------------------
	useEffect(() => {
		let cancelled = false
		setAnnotations([])
		setDraft(null)
		setSelectedId(null)
		setDirty(false)
		setSessionLabels(null)
		setSegmentLabels({})
		resetHistory()
		if (!sessionFolder || !window.electronAPI?.readSessionAnnotations) return
		void (async () => {
			try {
				const t0 = nowMs()
				const { data, labelsFile } = await readSidecars(sessionFolder)
				if (cancelled) return
				const loaded = sanitizeAnnotations(data?.annotations)
				setAnnotations(loaded)
				applyFileMeta(data, labelsFile)
				setDirty(false)
				if (data)
					logAnnotationEvent("import", nowMs() - t0, {
						count: loaded.length,
						detail: { version: data.version ?? null, labels: data.labels?.length ?? 0 }
					})
			} catch {
				if (!cancelled) setAnnotations([])
			}
		})()
		return () => {
			cancelled = true
		}
	}, [sessionFolder, applyFileMeta, readSidecars, resetHistory, logAnnotationEvent])

	// Discard unsaved edits by reloading the last saved annotations from disk.
	const discardChanges = useCallback(async () => {
		setDraft(null)
		setSelectedId(null)
		if (!sessionFolder || !window.electronAPI?.readSessionAnnotations) {
			setAnnotations([])
			setSessionLabels(null)
			setSegmentLabels({})
			setDirty(false)
			return
		}
		try {
			const { data, labelsFile } = await readSidecars(sessionFolder)
			setAnnotations(sanitizeAnnotations(data?.annotations))
			applyFileMeta(data, labelsFile)
		} catch {
			setAnnotations([])
		}
		resetHistory()
		setDirty(false)
	}, [sessionFolder, applyFileMeta, readSidecars, resetHistory])

	const setLabels = useCallback((next: AnnotationLabel[]) => {
		setSessionLabels(sanitizeLabels(next))
		setDirty(true)
	}, [])

	const setSegmentLabel = useCallback((segment: number, labelId: number | null) => {
		setSegmentLabels(prev => {
			const next = { ...prev }
			if (labelId == null) delete next[segment]
			else next[segment] = labelId
			return next
		})
		setDirty(true)
	}, [])

	// ---- Placement ----------------------------------------------------------
	const resolveLabelId = useCallback((): number | null => {
		if (activeLabelId != null) return activeLabelId
		return channelLabels[0]?.id ?? null
	}, [activeLabelId, channelLabels])

	const handleChartClick = useCallback(
		(segment: number, dataX: number, hitId: string | null) => {
			if (!enabled) return

			if (mode === "idle") {
				setSelectedId(hitId)
				return
			}

			if (mode === "point") {
				const labelId = resolveLabelId()
				if (labelId == null) return
				const x = snap(dataX)
				const ann = makeAnnotation(segment, x, x, labelId)
				commit(`add:${ann.id}`, prev => [...prev, ann])
				setSelectedId(ann.id)
				return
			}

			if (mode === "interval") {
				if (!draft) {
					setDraft({ startSec: dataX })
					return
				}
				const labelId = resolveLabelId()
				setDraft(null)
				if (labelId == null) return
				const ann = makeAnnotation(
					segment,
					snap(Math.min(draft.startSec, dataX)),
					snap(Math.max(draft.startSec, dataX)),
					labelId
				)
				commit(`add:${ann.id}`, prev => [...prev, ann])
				setSelectedId(ann.id)
				return
			}
		},
		[enabled, mode, draft, resolveLabelId, commit, snap]
	)

	const handleChartDoubleClick = useCallback(
		(hitId: string | null) => {
			if (!enabled) return
			if (hitId) setSelectedId(hitId)
		},
		[enabled]
	)

	const removeSelected = useCallback(() => {
		setSelectedId(prev => {
			if (prev) commit(`del:${prev}`, list => list.filter(a => a.id !== prev))
			return null
		})
	}, [commit])

	const toggleMode = useCallback((target: Exclude<AnnotationMode, "idle">) => {
		setDraft(null)
		setMode(m => (m === target ? "idle" : target))
	}, [])

	const setAnnotationNote = useCallback((id: string, note: string) => {
		commit(`note:${id}`, list => list.map(a => (a.id === id ? { ...a, note, updatedAt: nowIso() } : a)))
	}, [commit])

	const setAnnotationLabel = useCallback((id: string, labelId: number) => {
		commit(`label:${id}`, list => list.map(a => (a.id === id ? { ...a, labelId, updatedAt: nowIso() } : a)))
	}, [commit])

	const setAnnotationBounds = useCallback(
		(id: string, edge: "t0" | "t1" | "point", x: number) => {
			const sx = snap(x)
			commit(`bounds:${id}`, list =>
				list.map(a => {
					if (a.id !== id) return a
					const ts = nowIso()
					if (edge === "point") return { ...a, t0: sx, t1: sx, updatedAt: ts }
					if (edge === "t0") return { ...a, t0: Math.min(sx, a.t1), updatedAt: ts }
					return { ...a, t1: Math.max(sx, a.t0), updatedAt: ts }
				})
			)
		},
		[commit, snap]
	)

	const setAnnotationSpan = useCallback(
		(id: string, t0: number, t1: number) => {
			const a0 = snap(t0)
			const a1 = snap(t1)
			commit(`move:${id}`, list =>
				list.map(a =>
					a.id === id ? { ...a, t0: Math.min(a0, a1), t1: Math.max(a0, a1), updatedAt: nowIso() } : a
				)
			)
		},
		[commit, snap]
	)

	// Remove only the annotations of a segment that are visible in the given
	// time window (i.e. overlap [startSec, endSec]).
	const clearAnnotationsInRange = useCallback(
		(segment: number, startSec: number, endSec: number) => {
			commit(`clear:${Date.now()}`, list =>
				list.filter(a => {
					if (a.segment !== segment) return true
					const overlaps = a.t1 >= startSec && a.t0 <= endSec
					return !overlaps
				})
			)
			setSelectedId(null)
			setDraft(null)
		},
		[commit]
	)

	const removeAnnotation = useCallback(
		(id: string) => {
			commit(`del:${id}`, list => list.filter(a => a.id !== id))
			setSelectedId(prev => (prev === id ? null : prev))
		},
		[commit]
	)

	const clearInteraction = useCallback(() => {
		setDraft(null)
		setSelectedId(null)
		setMode("idle")
	}, [])

	// ---- Keyboard shortcuts -------------------------------------------------
	useEffect(() => {
		if (!enabled) return
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null
			if (
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable)
			) {
				return
			}

			const key = event.key
			if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "Z")) {
				event.preventDefault()
				if (event.shiftKey) redo()
				else undo()
				return
			}
			if ((event.ctrlKey || event.metaKey) && (key === "y" || key === "Y")) {
				event.preventDefault()
				redo()
				return
			}
			if (key === "p" || key === "P") {
				event.preventDefault()
				toggleMode("point")
			} else if (key === "i" || key === "I") {
				event.preventDefault()
				toggleMode("interval")
			} else if (key === "Escape") {
				setDraft(null)
				setSelectedId(null)
				setMode("idle")
			} else if (key === "Delete" || key === "Backspace") {
				event.preventDefault()
				removeSelected()
			} else if (key >= "1" && key <= "9") {
				const idx = Number(key) - 1
				const label = channelLabels[idx]
				if (label) {
					event.preventDefault()
					setActiveLabelId(label.id)
				}
			}
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [enabled, channelLabels, removeSelected, toggleMode, undo, redo])

	// Cancel any in-progress interaction when leaving annotation mode.
	useEffect(() => {
		if (!enabled) {
			setDraft(null)
			setMode("idle")
		}
	}, [enabled])

	// ---- Persistence --------------------------------------------------------
	const save = useCallback(async () => {
		if (!sessionFolder || !window.electronAPI?.writeSessionAnnotations) return
		setSaving(true)
		const t0 = nowMs()
		try {
			const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 1000
			const segStartMs = new Map((segments ?? []).map(s => [s.index, s.startedAt]))
			const anchored = annotations.map(({ t0, t1, ...rest }) => {
				const base = segStartMs.get(rest.segment)
				return {
					...rest,
					ti: t0,
					tf: t1,
					sample: Math.round(t0 * rate),
					sampleEnd: Math.round(t1 * rate),
					atStartMs: typeof base === "number" ? Math.round(base + t0 * 1000) : null,
					atEndMs: typeof base === "number" ? Math.round(base + t1 * 1000) : null
				}
			})
			const savedAt = new Date().toISOString()
			const payload: AnnotationsFile = {
				version: 3,
				savedAt,
				annotations: anchored,
				labels: effectiveLabels,
				segmentLabels
			}
			await window.electronAPI.writeSessionAnnotations(sessionFolder, payload)
			await window.electronAPI.writeSessionLabels?.(sessionFolder, {
				schemaVersion: 1,
				savedAt,
				labels: effectiveLabels
			})
			setDirty(false)
			logAnnotationEvent("save", nowMs() - t0, {
				count: anchored.length,
				detail: { labels: effectiveLabels.length, segmentLabels: Object.keys(segmentLabels).length }
			})
		} finally {
			setSaving(false)
		}
	}, [sessionFolder, annotations, effectiveLabels, segmentLabels, sampleRate, segments, logAnnotationEvent])

	const exportCsv = useCallback(async () => {
		await save()
		if (!sessionFolder || !window.electronAPI?.exportAnnotationsCsv) return null
		const t0 = nowMs()
		const result = await window.electronAPI.exportAnnotationsCsv(sessionFolder)
		logAnnotationEvent("export", nowMs() - t0, {
			count: annotationsRef.current.length,
			detail: { ok: (result as { ok?: boolean } | null)?.ok ?? null }
		})
		return result
	}, [save, sessionFolder, logAnnotationEvent])

	return {
		annotations,
		labels: effectiveLabels,
		segmentLabels,
		setSegmentLabel,
		setLabels,
		exportCsv,
		undo,
		redo,
		canUndo,
		canRedo,
		mode,
		setMode,
		toggleMode,
		draft,
		selectedId,
		setSelectedId,
		activeLabelId,
		setActiveLabelId,
		activeLabel,
		dirty,
		saving,
		handleChartClick,
		handleChartDoubleClick,
		removeSelected,
		removeAnnotation,
		setAnnotationNote,
		setAnnotationLabel,
		setAnnotationBounds,
		setAnnotationSpan,
		clearAnnotationsInRange,
		discardChanges,
		clearInteraction,
		save
	}
}
