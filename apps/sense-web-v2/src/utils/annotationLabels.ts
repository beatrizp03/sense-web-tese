import { useEffect, useMemo, useState } from "react"

export type AnnotationAppliesTo = "channel" | "segment"

export interface AnnotationLabel {
	id: number
	name: string
	category: string
	description: string
	color: string
	appliesTo: AnnotationAppliesTo
}

/** Default annotation label set used until the user customises it. */
export const DEFAULT_ANNOTATION_LABELS: AnnotationLabel[] = [
	{ id: 1, name: "noise", category: "quality", description: "Corrupted data", color: "#6E6E6E", appliesTo: "channel" },
	{ id: 2, name: "disturbance", category: "quality", description: "Protocol deviation", color: "#E0A52E", appliesTo: "channel" },
	{ id: 3, name: "stimulus", category: "event", description: "External cue", color: "#1F77B4", appliesTo: "channel" },
	{ id: 4, name: "onset", category: "event", description: "Event start", color: "#2BA84A", appliesTo: "channel" },
	{ id: 5, name: "offset", category: "event", description: "Event end", color: "#0F5A2C", appliesTo: "channel" },
	{ id: 6, name: "peak", category: "feature", description: "Local maximum", color: "#B83BCB", appliesTo: "channel" },
	{ id: 7, name: "baseline", category: "state", description: "Resting period", color: "#BFB89E", appliesTo: "channel" },
	{ id: 8, name: "movement", category: "quality", description: "Motion artifact", color: "#E84545", appliesTo: "channel" },
	{ id: 20, name: "healthy", category: "class", description: "Control subject", color: "#3FA66A", appliesTo: "segment" },
	{ id: 21, name: "sick", category: "class", description: "Clinical condition", color: "#C0392B", appliesTo: "segment" }
]

const STORAGE_KEY = "processing:annotationLabels"

let cache: AnnotationLabel[] | null = null
const listeners = new Set<() => void>()

const isBrowser = () => typeof window !== "undefined"

function sanitize(value: unknown): AnnotationLabel[] | null {
	if (!Array.isArray(value)) return null
	const out: AnnotationLabel[] = []
	for (const item of value) {
		if (!item || typeof item !== "object") continue
		const raw = item as Record<string, unknown>
		const id = Number(raw.id)
		const name = typeof raw.name === "string" ? raw.name : ""
		const color = typeof raw.color === "string" ? raw.color : "#888888"
		const appliesTo = raw.appliesTo === "segment" ? "segment" : "channel"
		if (!Number.isFinite(id)) continue
		out.push({
			id,
			name,
			category: typeof raw.category === "string" ? raw.category : "",
			description: typeof raw.description === "string" ? raw.description : "",
			color,
			appliesTo
		})
	}
	return out
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

function nextId(list: AnnotationLabel[]): number {
	return list.reduce((max, label) => Math.max(max, label.id), 0) + 1
}

export function addAnnotationLabel(partial?: Partial<AnnotationLabel>): AnnotationLabel {
	const list = getAnnotationLabels()
	const label: AnnotationLabel = {
		id: nextId(list),
		name: "new label",
		category: "custom",
		description: "",
		color: "#888888",
		appliesTo: "channel",
		...partial
	}
	setAnnotationLabels([...list, label])
	return label
}

export function updateAnnotationLabel(id: number, patch: Partial<AnnotationLabel>): void {
	setAnnotationLabels(getAnnotationLabels().map(label => (label.id === id ? { ...label, ...patch } : label)))
}

export function removeAnnotationLabel(id: number): void {
	setAnnotationLabels(getAnnotationLabels().filter(label => label.id !== id))
}

export function resetAnnotationLabels(): void {
	setAnnotationLabels(DEFAULT_ANNOTATION_LABELS.map(label => ({ ...label })))
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
			remove: removeAnnotationLabel,
			reset: resetAnnotationLabels
		}),
		[]
	)

	return { labels, ...actions }
}
