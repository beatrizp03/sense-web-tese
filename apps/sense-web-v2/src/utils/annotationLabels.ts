import { useEffect, useMemo, useState } from "react"

export type AnnotationAppliesTo = "channel" | "segment"

export interface AnnotationLabel {
	id: number
	name: string
	category: string
	description: string
	color: string
	appliesTo: AnnotationAppliesTo
	predefined?: boolean
	retired?: boolean
}

/** Default annotation label set the dictionary is seeded with. */
export const DEFAULT_ANNOTATION_LABELS: AnnotationLabel[] = [
	{ id: 1, name: "noise", category: "quality", description: "Corrupted data", color: "#6E6E6E", appliesTo: "channel", predefined: true },
	{ id: 2, name: "disturbance", category: "quality", description: "Protocol deviation", color: "#E0A52E", appliesTo: "channel", predefined: true },
	{ id: 3, name: "stimulus", category: "event", description: "External cue", color: "#1F77B4", appliesTo: "channel", predefined: true },
	{ id: 4, name: "onset", category: "event", description: "Event start", color: "#2BA84A", appliesTo: "channel", predefined: true },
	{ id: 5, name: "offset", category: "event", description: "Event end", color: "#0F5A2C", appliesTo: "channel", predefined: true },
	{ id: 6, name: "peak", category: "feature", description: "Local maximum", color: "#B83BCB", appliesTo: "channel", predefined: true },
	{ id: 7, name: "baseline", category: "state", description: "Resting period", color: "#BFB89E", appliesTo: "channel", predefined: true },
	{ id: 8, name: "movement", category: "quality", description: "Motion artifact", color: "#E84545", appliesTo: "channel", predefined: true },
	{ id: 20, name: "healthy", category: "class", description: "Control subject", color: "#3FA66A", appliesTo: "segment", predefined: true },
	{ id: 21, name: "sick", category: "class", description: "Clinical condition", color: "#C0392B", appliesTo: "segment", predefined: true }
]

const STORAGE_KEY = "processing:annotationLabels"

let cache: AnnotationLabel[] | null = null
const listeners = new Set<() => void>()

const isBrowser = () => typeof window !== "undefined"

const CANONICAL_IDS = new Set(DEFAULT_ANNOTATION_LABELS.map(label => label.id))

function sanitize(value: unknown): AnnotationLabel[] | null {
	if (!Array.isArray(value)) return null
	const out: AnnotationLabel[] = []
	for (const item of value) {
		if (!item || typeof item !== "object") continue
		const raw = item as Record<string, unknown>
		const id = Number(raw.id)
		if (!Number.isFinite(id)) continue
		const appliesTo: AnnotationAppliesTo = raw.appliesTo === "segment" ? "segment" : "channel"
		const predefined =
			raw.predefined === true || (raw.predefined === undefined && CANONICAL_IDS.has(id))
		out.push({
			id,
			name: typeof raw.name === "string" ? raw.name : "",
			category: typeof raw.category === "string" ? raw.category : "",
			description: typeof raw.description === "string" ? raw.description : "",
			color: typeof raw.color === "string" ? raw.color : "#888888",
			appliesTo,
			predefined,
			retired: raw.retired === true
		})
	}
	return out
}

export function sanitizeLabels(value: unknown): AnnotationLabel[] {
	return sanitize(value) ?? []
}

export function getAnnotationLabels(): AnnotationLabel[] {
	if (cache) return cache
	if (!isBrowser()) return DEFAULT_ANNOTATION_LABELS
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY)
		cache = (raw ? sanitize(JSON.parse(raw)) : null) ?? DEFAULT_ANNOTATION_LABELS
	} catch {
		cache = DEFAULT_ANNOTATION_LABELS
	}
	return cache
}

export function setAnnotationLabels(next: AnnotationLabel[]): void {
	cache = next
	if (isBrowser()) {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
		} catch {
			// ignore quota / serialization errors
		}
	}
	listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/**
 * Next id for a new label: one past the highest id ever seen, INCLUDING tombstones.
 * Because retired labels are never removed, this is monotonic — ids are never reused.
 */
export function nextLabelId(list: AnnotationLabel[]): number {
	return list.reduce((max, label) => Math.max(max, label.id), 0) + 1
}

export function addAnnotationLabel(partial?: Partial<AnnotationLabel>): AnnotationLabel {
	const list = getAnnotationLabels()
	const label: AnnotationLabel = {
		id: partial?.id ?? nextLabelId(list),
		name: "new label",
		category: "custom",
		description: "",
		color: "#888888",
		appliesTo: "channel",
		predefined: false,
		retired: false,
		...partial
	}
	setAnnotationLabels([...list, label])
	return label
}

export function updateAnnotationLabel(id: number, patch: Partial<AnnotationLabel>): void {
	const { id: _ignoredId, ...safe } = patch
	setAnnotationLabels(getAnnotationLabels().map(label => (label.id === id ? { ...label, ...safe } : label)))
}

export function retireAnnotationLabel(id: number): void {
	setAnnotationLabels(getAnnotationLabels().map(label => (label.id === id ? { ...label, retired: true } : label)))
}

export function restoreAnnotationLabel(id: number): void {
	setAnnotationLabels(getAnnotationLabels().map(label => (label.id === id ? { ...label, retired: false } : label)))
}

/**
 * Restore the predefined seed (attributes + un-retired) and retire any user-added
 * labels as tombstones. User labels are never dropped, so id monotonicity holds.
 */
export function resetAnnotationLabels(): void {
	const seed = DEFAULT_ANNOTATION_LABELS.map(label => ({ ...label }))
	const userTombstones = getAnnotationLabels()
		.filter(label => !CANONICAL_IDS.has(label.id))
		.map(label => ({ ...label, retired: true }))
	setAnnotationLabels([...seed, ...userTombstones])
}

export function useAnnotationLabels() {
	const [labels, setLabels] = useState<AnnotationLabel[]>(DEFAULT_ANNOTATION_LABELS)

	useEffect(() => {
		setLabels(getAnnotationLabels())
		return subscribe(() => setLabels(getAnnotationLabels()))
	}, [])

	const actions = useMemo(
		() => ({
			add: addAnnotationLabel,
			update: updateAnnotationLabel,
			retire: retireAnnotationLabel,
			restore: restoreAnnotationLabel,
			reset: resetAnnotationLabels
		}),
		[]
	)

	return { labels, ...actions }
}
