import { useEffect, useRef, useState } from "react"

import Image from "next/image"

import { useDarkTheme } from "@scientisst/react-ui/dark-theme"
import { faCheck, faToolbox, faWaveSquare } from "@fortawesome/free-solid-svg-icons"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
	ButtonCheckboxGroupField,
	ButtonRadioGroupField,
	ImageRadioGroupField,
	NumberField,
	TextButton
} from "@scientisst/react-ui/components/inputs"
import { FormikAutoSubmit } from "@scientisst/react-ui/components/utils"
import { SCIENTISST_COMUNICATION_MODE } from "@scientisst/sense/future"
import clsx from "clsx"
import { Form, Formik } from "formik"
import resolveConfig from "tailwindcss/resolveConfig"
import * as Yup from "yup"

import tailwindConfig from "../../tailwind.config"
import CoreBottom from "../assets/boards/core-bottom.svg"
import CoreTop from "../assets/boards/core-top.svg"
import AnnotationLabelsEditor from "../components/processing/AnnotationLabelsEditor"
import SenseLayout from "../components/layout/SenseLayout"
import { useAnnotationLabels } from "../utils/annotationLabels"
import {
	applySessionSettingsSnapshot,
	clearLastSessionSettingsPersistent,
	getCurrentSettings,
	loadLastSessionSettingsPersistent,
	saveCurrentSettings,
	SessionSettingsSnapshot
} from "../utils/sessionSettingsHistory"

const SIGNAL_TYPE_OPTIONS = [
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

const ACC_AXIS_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "X axis", value: "x" },
	{ label: "Y axis", value: "y" },
	{ label: "Z axis", value: "z" }
]

const CHANNEL_OPTIONS = [
	{ name: "AI1", value: "AI1" },
	{ name: "AI2", value: "AI2" },
	{ name: "AI3", value: "AI3" },
	{ name: "AI4", value: "AI4" },
	{ name: "AI5", value: "AI5" },
	{ name: "AI6", value: "AI6" },
	{ name: "AX1", value: "AX1" },
	{ name: "AX2", value: "AX2" }
]

function getOrderedEegChannels(
	channelSignalKinds: Record<string, string>,
	channels: string[]
) {
	return channels.filter(channel => channelSignalKinds[channel] === "eeg")
}

const schema = Yup.object().shape({
	deviceType: Yup.string().oneOf(["sense", "maker"]).required(),
	communication: Yup.number()
		.oneOf([
			SCIENTISST_COMUNICATION_MODE.WEBSOCKET,
			SCIENTISST_COMUNICATION_MODE.WEBSERIAL
		])
		.test(
			"bluetooth",
			"Bluetooth is not supported on your current browser.",
			value =>
				value !== SCIENTISST_COMUNICATION_MODE.WEBSERIAL ||
				typeof (navigator as any).serial !== "undefined"
		)
		.required(),
	baudRate: Yup.number().when("deviceType", {
		is: "maker",
		then: Yup.number().integer().min(9600).max(9600).required()
	}),
	samplingRate: Yup.number().when("deviceType", {
		is: "sense",
		then: Yup.number().integer().min(1).max(16000).required()
	}),
	channels: Yup.array().when("deviceType", {
		is: "sense",
		then: Yup.array()
			.min(1, "You must select at least one channel")
			.required()
	})
})

const fullConfig = resolveConfig(tailwindConfig)
const primaryDarkColor =
	(fullConfig.theme as any)?.colors?.["background-dark"] ?? "#1C1C1E"
const backgroundAccentDarkColor =
	(fullConfig.theme as any)?.colors?.["background-accent-dark"] ?? "#2C2C2E"
const primaryLightColor =
	(fullConfig.theme as any)?.colors?.["background-light"] ?? "#FFFFFF"
const backgroundAccentLightColor =
	(fullConfig.theme as any)?.colors?.["background-accent-light"] ?? "#F2F2F7"

const Page = () => {
	const isDark = useDarkTheme()
	const { labels: annotationLabels } = useAnnotationLabels()
	const [showSaved, setShowSaved] = useState(false)
	const savedHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const firstSubmitRef = useRef(true)
	const [loaded, setLoaded] = useState(false)
	const [showLabelEditor, setShowLabelEditor] = useState(false)
	const [showHistoryModal, setShowHistoryModal] = useState(false)
	const [settingsHistory, setSettingsHistory] =
		useState<SessionSettingsSnapshot[]>([])
	const [defaultValues, setDefaultValues] = useState({
		deviceType: "sense",
		communication: SCIENTISST_COMUNICATION_MODE.WEBSERIAL,
		baudRate: 9600,
		samplingRate: 1000,
		channels: ["AI1", "AI2", "AI3", "AI4", "AI5", "AI6"],
		channelSignalKinds: {} as Record<string, string>,
		channelSignalAxes: {} as Record<string, string>
	})

	useEffect(() => {
		if (typeof window === "undefined" || loaded) return

		void (async () => {
			try {
				setSettingsHistory(await loadLastSessionSettingsPersistent())
			} catch {
				setSettingsHistory([])
			}

			setDefaultValues(current => ({
				...current,
				communication:
					typeof (navigator as any).serial !== "undefined"
						? SCIENTISST_COMUNICATION_MODE.WEBSERIAL
						: SCIENTISST_COMUNICATION_MODE.WEBSOCKET,
				...getCurrentSettings()
			}))
			setLoaded(true)
		})()
	}, [loaded])

	useEffect(
		() => () => {
			if (savedHideTimer.current) clearTimeout(savedHideTimer.current)
		},
		[]
	)

	const formatSavedAt = (savedAt: number): string => {
		const date = new Date(savedAt)
		if (Number.isNaN(date.getTime())) return "Unknown date"
		return date.toLocaleString()
	}

	return (
		<SenseLayout
			title="Sense Settings"
			shortTitle="Settings"
			returnHref="/"
			className="container flex flex-col items-center justify-start pb-"
			style={{
				minHeight: "calc(100vh - 18.5rem)"
			}}
		>
			{loaded && (
				<Formik
					initialValues={defaultValues}
					validationSchema={schema}
					onSubmit={values => {
						const selectedChannels = Array.isArray(values.channels)
							? values.channels.map(String)
							: []
						const rawSignalKinds =
							typeof values.channelSignalKinds === "object" &&
							values.channelSignalKinds !== null
								? (values.channelSignalKinds as Record<string, string>)
								: {}
						const rawSignalAxes =
							typeof values.channelSignalAxes === "object" &&
							values.channelSignalAxes !== null
								? (values.channelSignalAxes as Record<string, string>)
								: {}

						const channelSignalKinds = Object.fromEntries(
							Object.entries(rawSignalKinds).filter(
								([channel, kind]) =>
									selectedChannels.includes(channel) &&
									typeof kind === "string" &&
									kind.length > 0
							)
						)

						const channelSignalAxes = Object.fromEntries(
							Object.entries(rawSignalAxes).filter(
								([channel, axis]) =>
									selectedChannels.includes(channel) &&
									channelSignalKinds[channel] === "acc" &&
									typeof axis === "string" &&
									["x", "y", "z"].includes(axis)
							)
						)

						const eegChannels = getOrderedEegChannels(
							channelSignalKinds,
							selectedChannels
						)

						saveCurrentSettings({
							...values,
							...(eegChannels.length > 0 ? { eegChannels } : {}),
							channelSignalKinds,
							channelSignalAxes
						} as SessionSettingsSnapshot["settings"])

						// FormikAutoSubmit fires once on mount; skip that so the
						// "Saved" indicator only shows after a real change.
						if (firstSubmitRef.current) {
							firstSubmitRef.current = false
							return
						}

						setShowSaved(true)
						if (savedHideTimer.current) clearTimeout(savedHideTimer.current)
						savedHideTimer.current = setTimeout(
							() => setShowSaved(false),
							2000
						)
					}}
				>
					{({ values, setValues }) => (
						<>
						<Form
							className="relative flex w-full flex-col items-center rounded-xl p-6"
						>
							<FormikAutoSubmit delay={100} />
							<div
								role="status"
								aria-live="polite"
								className={clsx(
									"absolute left-4 top-12 z-10 flex -translate-y-1/2 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium shadow-sm transition-opacity duration-300",
									showSaved ? "opacity-100" : "pointer-events-none opacity-0"
								)}
								style={{
									backgroundColor: isDark
										? primaryLightColor
										: primaryDarkColor,
									color: isDark ? primaryDarkColor : primaryLightColor
								}}
							>
								<FontAwesomeIcon icon={faCheck} className="h-3.5 w-3.5" />
								Settings saved
							</div>
							<div className="absolute right-4 top-12 z-10 -translate-y-1/2">
								<TextButton
									size={"base"}
									className="text-sm"
									onClick={event => {
										event.preventDefault()
										void (async () => {
											setSettingsHistory(await loadLastSessionSettingsPersistent())
											setShowHistoryModal(true)
										})()
									}}
								>
									History
								</TextButton>
							</div>
							<ImageRadioGroupField
								label="Device Type"
								id="deviceType"
								name="deviceType"
								center
								className="w-full max-w-[29.25rem]"
								options={[
									{
										name: "Sense",
										value: "sense",
										img: (
											<FontAwesomeIcon
												icon={faWaveSquare}
												className="h-16 w-16"
											/>
										)
									},
									{
										name: "Maker",
										value: "maker",
										img: (
											<FontAwesomeIcon
												icon={faToolbox}
												className="h-16 w-16"
											/>
										)
									}
								]}
							/>
							{values.deviceType === "sense" && (
								<>
									<ButtonRadioGroupField
										label="Communication"
										id="communication"
										name="communication"
										center
										options={[
											{
												name: "Bluetooth",
												value: SCIENTISST_COMUNICATION_MODE.WEBSERIAL
											},
											{
												name: "WiFi",
												value: SCIENTISST_COMUNICATION_MODE.WEBSOCKET
											}
										]}
										className="w-full max-w-[29.25rem]"
									/>
									<NumberField
										label="Sampling Rate"
										name="samplingRate"
										id="samplingRate"
										min={1}
										max={16000}
										center
										className="w-full max-w-[29.25rem]"
									/>
									<ButtonCheckboxGroupField
										label="Channels"
										id="channels"
										name="channels"
										center
										options={CHANNEL_OPTIONS}
										image={hovered => (
											<div className="flex w-full flex-col items-center gap-3">
												{Array.isArray(values.channels) && values.channels.length > 0 && (
													<>
														<span className="font-secondary text-lg">Signal Types</span>
														<div className="mt-2 flex max-w-[11rem] flex-wrap justify-center gap-4 sm:max-w-none">
														{CHANNEL_OPTIONS.map(channelOption => {
															const channel = String(channelOption.value)
															const isSelected = values.channels.includes(channel)
															const channelSignalKinds =
																typeof values.channelSignalKinds === "object" &&
																values.channelSignalKinds !== null
																	? (values.channelSignalKinds as Record<string, string>)
																	: {}
															const signalTypeValue = channelSignalKinds[channel] ?? ""
																		const channelSignalAxes =
																			typeof values.channelSignalAxes === "object" &&
																			values.channelSignalAxes !== null
																				? (values.channelSignalAxes as Record<string, string>)
																				: {}
																		const signalAxisValue = channelSignalAxes[channel] ?? ""

															return (
																<div
																	key={`signal-type-${channel}`}
																	className="relative flex h-24 items-center justify-center"
																>
																	<span
																		className={clsx(
																			"invisible flex h-12 min-w-[3rem] items-center justify-center rounded-full",
																			{
																				"border-[3px]": !isSelected
																			}
																		)}
																		style={{
																			padding: !isSelected ? "0 calc(1rem - 3px)" : "0 1rem"
																		}}
																	>
																		{channel}
																	</span>
																	{isSelected ? (
																		<select
																			value={signalTypeValue}
																			onChange={event => {
																				const nextValue = event.target.value
																				const currentMap =
																					typeof values.channelSignalKinds === "object" &&
																					values.channelSignalKinds !== null
																						? {
																							...(values.channelSignalKinds as Record<string, string>)
																					  }
																						: {}

																				// Validation: ACC can only have 3 channels max
																				if (nextValue === "acc" && signalTypeValue !== "acc") {
																					const accChannelCount = Object.values(currentMap).filter(kind => kind === "acc").length
																					if (accChannelCount >= 3) {
																						alert("ACC can only be assigned to a maximum of 3 channels (X, Y, Z axes)")
																						return
																					}
																				}

																				if (!nextValue) {
																					delete currentMap[channel]
																				} else {
																					currentMap[channel] = nextValue
																				}

																				setValues({
																					...values,
																						channelSignalKinds: currentMap,
																						channelSignalAxes:
																							nextValue === "acc"
																								? {
																										...(typeof values.channelSignalAxes === "object" && values.channelSignalAxes !== null
																											? (values.channelSignalAxes as Record<string, string>)
																											: {}),
																										[channel]: signalAxisValue || "x"
																								}
																							: (() => {
																								const nextAxes =
																									typeof values.channelSignalAxes === "object" && values.channelSignalAxes !== null
																											? { ...(values.channelSignalAxes as Record<string, string>) }
																											: {}
																										delete nextAxes[channel]
																										return nextAxes
																								})()
																				})
																			}}
																			className="border-primary bg-background-accent text-over-background absolute left-0 top-0 h-12 w-full appearance-none rounded-full border-[2px] px-3 text-center text-sm"
																		>
																			{SIGNAL_TYPE_OPTIONS.map(option => {
																				// Disable ACC option if already 3 channels use it and current channel is not ACC
																				const isAccDisabled =
																					option.value === "acc" &&
																					signalTypeValue !== "acc" &&
																					(() => {
																						const currentMap =
																							typeof values.channelSignalKinds === "object" &&
																							values.channelSignalKinds !== null
																								? (values.channelSignalKinds as Record<string, string>)
																								: {}
																						return Object.values(currentMap).filter(kind => kind === "acc").length >= 3
																					})()

																				return (
																					<option
																						key={`${channel}-${option.value || "unspecified"}`}
																						value={option.value}
																						disabled={isAccDisabled}
																					>
																						{option.label}{isAccDisabled ? " (max 3 channels)" : ""}
																					</option>
																				)
																			})}
																		</select>
																	) : null}
																	{signalTypeValue === "acc" ? (
																		<select
																			value={signalAxisValue}
																			onChange={event => {
																				const nextAxis = event.target.value
																				setValues({
																					...values,
																					channelSignalAxes: {
																						...(typeof values.channelSignalAxes === "object" && values.channelSignalAxes !== null
																							? (values.channelSignalAxes as Record<string, string>)
																							: {}),
																						[channel]: nextAxis
																					}
																				})
																			}}
																				className="border-primary bg-background-accent text-over-background absolute left-0 top-14 h-12 w-full appearance-none rounded-full border-[2px] px-3 text-center text-sm"
																		>
																			{ACC_AXIS_OPTIONS.map(option => (
																				<option key={`${channel}-axis-${option.value || "unspecified"}`} value={option.value}>
																					{option.label}
																				</option>
																			))}
																		</select>
																	) : null}
																</div>
															)
														})}
														</div>
													</>
												)}
												<div className="hidden gap-8 sm:flex">
													<div className="relative flex flex-col items-center">
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI1"
															})}
															style={{ width: "4.5rem", height: "4.5rem", top: "0.25rem", left: "0" }}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI2"
															})}
															style={{
																width: "4.5rem",
																height: "4.5rem",
																top: "calc(4.75rem - 3px)",
																left: "0"
															}}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI3"
															})}
															style={{
																width: "4.5rem",
																height: "4.5rem",
																top: "calc(4.75rem - 3px)",
																right: "0"
															}}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AX1"
															})}
															style={{ width: "4.5rem", height: "4.5rem", top: "0.25rem", right: "0" }}
														/>
														<Image
															src={CoreTop}
															alt=""
															className="m-2"
															style={{ maxWidth: "16rem", height: "auto" }}
														/>
														<span className="font-secondary text-2xl">Top</span>
													</div>
													<div className="relative flex flex-col items-center">
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AX2"
															})}
															style={{ width: "4.5rem", height: "4.5rem", top: "0.25rem", left: "0" }}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI4"
															})}
															style={{
																width: "4.5rem",
																height: "4.5rem",
																top: "calc(4.75rem - 3px)",
																left: "0"
															}}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI5"
															})}
															style={{
																width: "4.5rem",
																height: "4.5rem",
																top: "calc(4.75rem - 3px)",
																right: "0"
															}}
														/>
														<div
															className={clsx("border-primary absolute rounded-lg border-[3px]", {
																hidden: hovered !== "AI6"
															})}
															style={{ width: "4.5rem", height: "4.5rem", top: "0.25rem", right: "0" }}
														/>
														<Image
															src={CoreBottom}
															alt=""
															className="m-2"
															style={{ maxWidth: "16rem", height: "auto" }}
														/>
														<span className="font-secondary text-2xl">Bottom</span>
													</div>
												</div>
											</div>
										)}
									/>
								</>
							)}
							{values.deviceType === "maker" && (
								<>
									<NumberField
										label="Baud Rate"
										name="baudRate"
										id="baudRate"
										min={0}
										max={16000}
										center
										className="w-full max-w-[29.25rem]"
									/>
								</>
							)}
							</Form>
							{showHistoryModal && (
								<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
									<div
										className="w-full max-w-xl rounded-lg p-6 shadow-lg"
										style={{ backgroundColor: isDark ? `${primaryDarkColor}E6` : `${primaryLightColor}E6` }}
									>
										<h2 className="mb-3 text-xl font-bold">Last sessions' history</h2>
										<p className="mb-4 text-sm opacity-80">
											Choose one of your recent session configurations.
										</p>

										{settingsHistory.length === 0 ? (
											<p className="mb-4">No previous sessions found yet.</p>
										) : (
											<ul className="mb-4 max-h-80 space-y-2 overflow-y-auto rounded-md p-2">
												{settingsHistory.map(snapshot => (
													<li key={snapshot.id}>
														<button
															type="button"
															className="w-full transform-gpu cursor-pointer rounded-md px-4 py-3 text-left transition-transform duration-150 ease-out hover:scale-[0.98] active:scale-[0.97]"
															style={{ backgroundColor: isDark ? backgroundAccentDarkColor : backgroundAccentLightColor }}
															onClick={() => {
															const snapshotSettings = applySessionSettingsSnapshot(snapshot)
															const nextValues = {
																...defaultValues,
																...snapshotSettings
															}
															
															// Ensure required fields for Sense device
															if ((snapshotSettings.deviceType ?? nextValues.deviceType) === "sense") {
																if (!Array.isArray(nextValues.channels) || nextValues.channels.length === 0) {
																	nextValues.channels = defaultValues.channels
																}
															}
															
																setDefaultValues(nextValues)
																setValues(nextValues)
																saveCurrentSettings(nextValues as SessionSettingsSnapshot["settings"])
																setShowHistoryModal(false)
															}}
														>
															<div className="font-semibold">{snapshot.label}</div>
															<div className="text-sm opacity-70">
																{formatSavedAt(snapshot.savedAt)}
															</div>
														</button>
													</li>
												))}
											</ul>
										)}

										<div className="flex justify-between">
											<TextButton
												size={"base"}
												onClick={() => {
													void (async () => {
														await clearLastSessionSettingsPersistent()
														setSettingsHistory([])
													})()
												}}
											>
												Reset History
											</TextButton>
											<button
												type="button"
												onClick={() => {
													setShowHistoryModal(false)
												}}
												className="rounded-lg border border-white/70 bg-transparent px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
											>
												Close
											</button>
										</div>
									</div>
								</div>
							)}
						</>
					)}
				</Formik>
			)}

			<section className="w-full max-w-2xl rounded-xl p-6">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="text-lg font-semibold text-over-background-highest">Annotation Labels</h2>
						<p className="mt-1 text-sm text-over-background-medium">
							Customise the labels used when annotating sessions (add, rename, recolor, or remove labels).
						</p>
					</div>
					<TextButton size="base" className="text-sm whitespace-nowrap" onClick={() => setShowLabelEditor(true)}>
						Edit labels
					</TextButton>
				</div>
				<div className="mt-4 flex flex-wrap gap-2">
					{annotationLabels.filter(label => !label.retired).length === 0 ? (
						<p className="text-sm text-over-background-medium">No labels defined.</p>
					) : (
						annotationLabels.filter(label => !label.retired).map(label => (
							<span
								key={label.id}
								className="inline-flex items-center gap-1.5 rounded-full border border-background-accent px-2.5 py-1 text-xs text-over-background-highest"
								title={`${label.appliesTo} · ${label.description || "no description"}`}
							>
								<span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
								{label.name || "(unnamed)"}
							</span>
						))
					)}
				</div>
			</section>

			<AnnotationLabelsEditor open={showLabelEditor} onClose={() => setShowLabelEditor(false)} />
		</SenseLayout>
	)
}

export default Page
