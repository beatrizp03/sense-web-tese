// Shared helpers/constants for the processing screen's channel mapping. These
// are used both by the page (to derive the applied signal kinds/axes that drive
// the chart) and by the analysis panel (to render the mapping controls).

export const SIGNAL_TYPE_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "ECG", value: "ecg" },
	{ label: "EDA", value: "eda" },
	{ label: "PPG", value: "ppg" },
	{ label: "EMG", value: "emg" },
	{ label: "RSP", value: "rsp" },
	{ label: "EOG", value: "eog" },
	{ label: "EEG", value: "eeg" },
	{ label: "PCG", value: "pcg" },
	{ label: "ACC", value: "acc" }
]

export const ACC_AXIS_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "X axis", value: "x" },
	{ label: "Y axis", value: "y" },
	{ label: "Z axis", value: "z" }
]

export function toRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, kind]) => typeof kind === "string" && kind.length > 0
		)
	) as Record<string, string>
}

export function toAxisRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, axis]) => typeof axis === "string" && ["x", "y", "z"].includes(axis)
		)
	) as Record<string, string>
}
