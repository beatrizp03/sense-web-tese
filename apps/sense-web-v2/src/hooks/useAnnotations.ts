import { useCallback, useEffect, useMemo, useState } from "react"

import { AnnotationLabel, sanitizeLabels } from "../utils/annotationLabels"

export type AnnotationType = "point" | "interval"
export type AnnotationMode = "idle" | "point" | "interval"

export interface Annotation {
	id: string
	segment: number
	type: AnnotationType
	startSec: number
	endSec: number
	labelId: number
	note: string
}

interface AnnotationsFile {
	version: number
	savedAt: string
	annotations: Annotation[]
	labels?: AnnotationLabel[]
	segmentLabels?: Record<number, number>
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
		const startSec = Number(raw.startSec)
		const endSec = Number(raw.endSec ?? raw.startSec)
		const labelId = Number(raw.labelId)
		if (!Number.isFinite(startSec) || !Number.isFinite(labelId)) continue
		const type: AnnotationType = raw.type === "interval" ? "interval" : "point"
		out.push({
			id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
			segment: Number(raw.segment) || 1,
			type,
			startSec,
			endSec: type === "interval" && Number.isFinite(endSec) ? endSec : startSec,
			labelId,
			note: typeof raw.note === "string" ? raw.note : ""
		})
	}
	return out
}

interface UseAnnotationsOptions {
	sessionFolder: string
	enabled: boolean
	labels: AnnotationLabel[]
}

export function useAnnotations({ sessionFolder, enabled, labels }: UseAnnotationsOptions) {
	const [annotations, setAnnotations] = useState<Annotation[]>([])
	const [activeLabelId, setActiveLabelId] = useState<number | null>(null)
	const [mode, setMode] = useState<AnnotationMode>("idle")
	const [draft, setDraft] = useState<{ startSec: number } | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [sessionLabels, setSessionLabels] = useState<AnnotationLabel[] | null>(null)
	const [segmentLabels, setSegmentLabels] = useState<Record<number, number>>({})

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

	const applyFileMeta = useCallback((data: AnnotationsFile | null) => {
		const fileLabels = data?.labels
		setSessionLabels(Array.isArray(fileLabels) && fileLabels.length > 0 ? sanitizeLabels(fileLabels) : null)
		setSegmentLabels(sanitizeSegmentLabels(data?.segmentLabels))
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
		if (!sessionFolder || !window.electronAPI?.readSessionAnnotations) return
		void (async () => {
			try {
				const data = (await window.electronAPI!.readSessionAnnotations!(sessionFolder)) as AnnotationsFile | null
				if (cancelled) return
				setAnnotations(sanitizeAnnotations(data?.annotations))
				applyFileMeta(data)
				setDirty(false)
			} catch {
				if (!cancelled) setAnnotations([])
			}
		})()
		return () => {
			cancelled = true
		}
	}, [sessionFolder, applyFileMeta])

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
			const data = (await window.electronAPI.readSessionAnnotations(sessionFolder)) as AnnotationsFile | null
			setAnnotations(sanitizeAnnotations(data?.annotations))
			applyFileMeta(data)
		} catch {
			setAnnotations([])
		}
		setDirty(false)
	}, [sessionFolder, applyFileMeta])

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

			if (hitId && !(mode === "interval" && draft)) {
				setSelectedId(hitId)
				return
			}

			if (mode === "point") {
				const labelId = resolveLabelId()
				if (labelId == null) return
				const id = newId()
				setAnnotations(prev => [
					...prev,
					{ id, segment, type: "point", startSec: dataX, endSec: dataX, labelId, note: "" }
				])
				setSelectedId(id)
				setDirty(true)
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
				const startSec = Math.min(draft.startSec, dataX)
				const endSec = Math.max(draft.startSec, dataX)
				const id = newId()
				setAnnotations(prev => [
					...prev,
					{ id, segment, type: "interval", startSec, endSec, labelId, note: "" }
				])
				setSelectedId(id)
				setDirty(true)
				return
			}

			setSelectedId(hitId)
		},
		[enabled, mode, draft, resolveLabelId]
	)

	const removeSelected = useCallback(() => {
		setSelectedId(prev => {
			if (!prev) return prev
			setAnnotations(list => {
				const next = list.filter(a => a.id !== prev)
				if (next.length !== list.length) setDirty(true)
				return next
			})
			return null
		})
	}, [])

	const toggleMode = useCallback((target: Exclude<AnnotationMode, "idle">) => {
		setDraft(null)
		setMode(m => (m === target ? "idle" : target))
	}, [])

	const setAnnotationNote = useCallback((id: string, note: string) => {
		setAnnotations(list => list.map(a => (a.id === id ? { ...a, note } : a)))
		setDirty(true)
	}, [])

	const setAnnotationLabel = useCallback((id: string, labelId: number) => {
		setAnnotations(list => list.map(a => (a.id === id ? { ...a, labelId } : a)))
		setDirty(true)
	}, [])

	// Remove only the annotations of a segment that are visible in the given
	// time window (i.e. overlap [startSec, endSec]).
	const clearAnnotationsInRange = useCallback(
		(segment: number, startSec: number, endSec: number) => {
			setAnnotations(list => {
				const next = list.filter(a => {
					if (a.segment !== segment) return true
					const aEnd = a.type === "interval" ? a.endSec : a.startSec
					const overlaps = aEnd >= startSec && a.startSec <= endSec
					return !overlaps
				})
				if (next.length !== list.length) setDirty(true)
				return next
			})
			setSelectedId(null)
			setDraft(null)
		},
		[]
	)

	const removeAnnotation = useCallback((id: string) => {
		setAnnotations(list => {
			const next = list.filter(a => a.id !== id)
			if (next.length !== list.length) setDirty(true)
			return next
		})
		setSelectedId(prev => (prev === id ? null : prev))
	}, [])

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
	}, [enabled, channelLabels, removeSelected, toggleMode])

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
		try {
			const payload: AnnotationsFile = {
				version: 1,
				savedAt: new Date().toISOString(),
				annotations,
				labels: effectiveLabels,
				segmentLabels
			}
			await window.electronAPI.writeSessionAnnotations(sessionFolder, payload)
			setDirty(false)
		} finally {
			setSaving(false)
		}
	}, [sessionFolder, annotations, effectiveLabels, segmentLabels])

	return {
		annotations,
		labels: effectiveLabels,
		segmentLabels,
		setSegmentLabel,
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
		removeSelected,
		removeAnnotation,
		setAnnotationNote,
		setAnnotationLabel,
		clearAnnotationsInRange,
		discardChanges,
		clearInteraction,
		save
	}
}
