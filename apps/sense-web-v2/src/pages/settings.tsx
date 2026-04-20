import { useEffect, useState } from "react"

import Image from "next/image"

import { faToolbox, faWaveSquare } from "@fortawesome/free-solid-svg-icons"
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
import SenseLayout from "../components/layout/SenseLayout"
import {
	applySessionSettingsSnapshot,
	loadLastSessionSettingsPersistent,
	SessionSettingsSnapshot
} from "../utils/sessionSettingsHistory"

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

const Page = () => {
	const [loaded, setLoaded] = useState(false)
	const [showHistoryModal, setShowHistoryModal] = useState(false)
	const [settingsHistory, setSettingsHistory] =
		useState<SessionSettingsSnapshot[]>([])
	const [defaultValues, setDefaultValues] = useState({
		deviceType: "sense",
		communication: SCIENTISST_COMUNICATION_MODE.WEBSERIAL,
		baudRate: 9600,
		samplingRate: 1000,
		channels: ["AI1", "AI2", "AI3", "AI4", "AI5", "AI6"]
	})

	useEffect(() => {
		if (typeof window === "undefined" || loaded) return

		setLoaded(true)
		void (async () => {
			setSettingsHistory(await loadLastSessionSettingsPersistent())

			setDefaultValues(current => ({
				...current,
				communication:
					typeof (navigator as any).serial !== "undefined"
						? SCIENTISST_COMUNICATION_MODE.WEBSERIAL
						: SCIENTISST_COMUNICATION_MODE.WEBSOCKET,
				...(JSON.parse(localStorage.getItem("settings") ?? "{}") || {})
			}))
		})()
	}, [loaded])

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
						localStorage.setItem("settings", JSON.stringify(values))
					}}
				>
					{({ values: { deviceType }, setValues }) => (
						<>
						<Form
							className="relative flex w-full flex-col items-center rounded-xl p-6"
						>
							<FormikAutoSubmit delay={100} />
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
							{deviceType === "sense" && (
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
										options={[
											{
												name: "AI1",
												value: "AI1"
											},
											{
												name: "AI2",
												value: "AI2"
											},
											{
												name: "AI3",
												value: "AI3"
											},
											{
												name: "AI4",
												value: "AI4"
											},
											{
												name: "AI5",
												value: "AI5"
											},
											{
												name: "AI6",
												value: "AI6"
											},
											{
												name: "AX1",
												value: "AX1"
											},
											{
												name: "AX2",
												value: "AX2"
											}
										]}
										image={hovered => (
											<div className="hidden gap-8 sm:flex">
												<div className="relative flex flex-col items-center">
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI1"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "0.25rem",
															left: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI2"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "calc(4.75rem - 3px)",
															left: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI3"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "calc(4.75rem - 3px)",
															right: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AX1"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "0.25rem",
															right: "0"
														}}
													/>
													<Image
														src={CoreTop}
														alt=""
														className="m-2"
														style={{
															maxWidth: "16rem",
															height: "auto"
														}}
													/>
													<span className="font-secondary text-2xl">
														Top
													</span>
												</div>
												<div className="relative flex flex-col items-center">
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI4"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "0.25rem",
															right: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI5"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "calc(4.75rem - 3px)",
															left: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AI6"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "calc(4.75rem - 3px)",
															right: "0"
														}}
													/>
													<div
														className={clsx(
															"border-primary absolute rounded-lg border-[3px]",
															{
																hidden:
																	hovered !==
																	"AX2"
															}
														)}
														style={{
															width: "4.5rem",
															height: "4.5rem",
															top: "0.25rem",
															left: "0"
														}}
													/>
													<Image
														src={CoreBottom}
														alt=""
														className="m-2"
														style={{
															maxWidth: "16rem",
															height: "auto"
														}}
													/>
													<span className="font-secondary text-2xl">
														Bottom
													</span>
												</div>
											</div>
										)}
									/>
								</>
							)}
							{deviceType === "maker" && (
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
										style={{ backgroundColor: `${primaryDarkColor}E6` }}
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
															style={{ backgroundColor: backgroundAccentDarkColor }}
															onClick={() => {
																const nextValues = {
																	...defaultValues,
																	...applySessionSettingsSnapshot(snapshot)
																}
																setDefaultValues(nextValues)
																setValues(nextValues)
																localStorage.setItem("settings", JSON.stringify(nextValues))
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

										<div className="flex justify-end">
											<TextButton
												size={"base"}
												onClick={() => {
													setShowHistoryModal(false)
												}}
											>
												Close
											</TextButton>
										</div>
									</div>
								</div>
							)}
						</>
					)}
				</Formik>
			)}
		</SenseLayout>
	)
}

export default Page
