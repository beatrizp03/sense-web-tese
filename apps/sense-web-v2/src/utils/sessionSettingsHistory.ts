export type SessionSettings = {
	deviceType?: "sense" | "maker"
	communication?: number
	baudRate?: number
	samplingRate?: number
	channels?: string[]
	[key: string]: unknown
}

export type SessionSettingsSnapshot = {
	id: string
	label: string
	savedAt: number
	settings: SessionSettings
}

const LAST_SESSION_SETTINGS_KEY = "lastSessionSettings"
const CURRENT_SETTINGS_KEY = "settings"
export const MAX_HISTORY = 5

function hasLocalStorage(): boolean {
	return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function hasElectronHistoryApi(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.electronAPI !== "undefined" &&
		typeof window.electronAPI.loadSessionSettingsHistory === "function" &&
		typeof window.electronAPI.saveSessionSettingsSnapshot === "function"
	)
}

function safeParse<T>(value: string | null, fallback: T): T {
	if (!value) return fallback
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

function getSettingsLabel(settings: SessionSettings): string {
	const deviceType = settings.deviceType ?? "sense"
	if (deviceType === "maker") {
		return `Maker • ${settings.baudRate ?? 9600} baud`
	}

	const channels = Array.isArray(settings.channels) ? settings.channels.length : 0
	const rate = settings.samplingRate ?? 1000
	const mode = settings.communication === 0 ? "WiFi" : "Bluetooth"
	return `Sense • ${channels} ch • ${rate} Hz • ${mode}`
}

function getSettingsFingerprint(settings: SessionSettings): string {
	const channels = Array.isArray(settings.channels)
		? [...settings.channels].map(String).sort()
		: []

	return JSON.stringify({
		deviceType: settings.deviceType ?? null,
		communication: settings.communication ?? null,
		baudRate: settings.baudRate ?? null,
		samplingRate: settings.samplingRate ?? null,
		channels
	})
}

export function getCurrentSettings(): SessionSettings {
	if (!hasLocalStorage()) return {}
	return safeParse<SessionSettings>(window.localStorage.getItem(CURRENT_SETTINGS_KEY), {})
}

export function loadLastSessionSettings(): SessionSettingsSnapshot[] {
	if (!hasLocalStorage()) return []
	const snapshots = safeParse<SessionSettingsSnapshot[]>(
		window.localStorage.getItem(LAST_SESSION_SETTINGS_KEY),
		[]
	)
	return Array.isArray(snapshots) ? snapshots : []
}

export function saveLastSessionSettings(settings: SessionSettings): SessionSettingsSnapshot[] {
	if (!hasLocalStorage()) return []
	const history = loadLastSessionSettings()
	const fingerprint = getSettingsFingerprint(settings)
	const alreadyExists = history.some(
		snapshot => getSettingsFingerprint(snapshot.settings) === fingerprint
	)
	if (alreadyExists) {
		return history
	}

	const nextSnapshot: SessionSettingsSnapshot = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		label: getSettingsLabel(settings),
		savedAt: Date.now(),
		settings
	}

	const nextHistory = [nextSnapshot, ...history]
		.filter((snapshot, index, all) => all.findIndex(item => item.id === snapshot.id) === index)
		.slice(0, MAX_HISTORY)

	window.localStorage.setItem(LAST_SESSION_SETTINGS_KEY, JSON.stringify(nextHistory))
	return nextHistory
}

export async function loadLastSessionSettingsPersistent(): Promise<SessionSettingsSnapshot[]> {
	if (hasElectronHistoryApi()) {
		const snapshots = await window.electronAPI!.loadSessionSettingsHistory!()
		return Array.isArray(snapshots) ? snapshots.slice(0, MAX_HISTORY) : []
	}
	return loadLastSessionSettings()
}

export async function saveLastSessionSettingsPersistent(
	settings: SessionSettings
): Promise<SessionSettingsSnapshot[]> {
	const snapshot: SessionSettingsSnapshot = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		label: getSettingsLabel(settings),
		savedAt: Date.now(),
		settings
	}

	if (hasElectronHistoryApi()) {
		const snapshots = await window.electronAPI!.saveSessionSettingsSnapshot!(snapshot)
		return Array.isArray(snapshots) ? snapshots.slice(0, MAX_HISTORY) : []
	}

	return saveLastSessionSettings(settings)
}

export function applySessionSettingsSnapshot(snapshot: SessionSettingsSnapshot): SessionSettings {
	return { ...snapshot.settings }
}

export function clearLastSessionSettings(): void {
	if (!hasLocalStorage()) return
	window.localStorage.removeItem(LAST_SESSION_SETTINGS_KEY)
}
