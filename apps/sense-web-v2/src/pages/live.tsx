import React, {
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState
	} from "react"

import { framePublisher } from "../../../../packages/esptool-js/src/FramePublisher"
import { registerUISubscriber } from "../../../../packages/esptool-js/src/UISubscriber"
import { registerStorageSubscriber } from "../../../../packages/esptool-js/src/StorageSubscriber"
import { registerProcessingSubscriber } from "../../../../packages/esptool-js/src/ProcessingSubscriber"

import Link from "next/link"
import { useRouter } from "next/router"

import { TextButton, TextField } from "@scientisst/react-ui/components/inputs"
import { FormikAutoSubmit } from "@scientisst/react-ui/components/utils"
import { useDarkTheme } from "@scientisst/react-ui/dark-theme"
import {
	CancelledByUserException,
	Device,
	Frame,
	Maker,
	SCIENTISST_CHANNEL,
	SCIENTISST_COMUNICATION_MODE,
	ScientISST
} from "@scientisst/sense/future"
import { Form, Formik } from "formik"
import resolveConfig from "tailwindcss/resolveConfig"

import tailwindConfig from "../../tailwind.config"
import CanvasChart from "../components/charts/CanvasChart"
import SenseLayout from "../components/layout/SenseLayout"

enum STATUS {
	DISCONNECTED,
	CONNECTION_LOST,
	CONNECTION_FAILED,
	CONNECTING,
	CONNECTED,
	ACQUIRING,
	PAUSED,
	STOPPING,
	STOPPED,
	STOPPED_AND_SAVED,
	OUT_OF_STORAGE
}

const fullConfig = resolveConfig(tailwindConfig)
const lineColorLight = fullConfig.theme.colors["primary-light"]
const lineColorDark = fullConfig.theme.colors["primary-dark"]
const outlineColorLight =
	fullConfig.theme.colors["over-background-highest-light"]
const outlineColorDark = fullConfig.theme.colors["over-background-highest-dark"]

// Buffer manager logic for Electron (local disk storage)
let electronSampleWriter: any = null
// TypeScript global declaration for electronAPI
declare global {
	interface Window {
		electronAPI?: {
			sendSample?: (sample: any) => void
			setBufferSize?: (size: number) => void
			startAcquisition?: (timestamp: string) => void
			flushSamples?: (finalize?: boolean) => void
		}
	}
}
if (window.electronAPI) {
	function saveSampleToDisk(sample: any) {
		window.electronAPI.sendSample?.(sample);
	}
	electronSampleWriter = { addSample: saveSampleToDisk }
}

const Page = () => {
	   const processingBufferLimit = useRef(5000)
	   const processFrame = useCallback((frame, buffer) => {
		   // Example: run real-time filtering, feature extraction, or logging
		   // For instance, calculate average, detect peaks, etc.
		   // console.log('Processing frame:', frame, 'Buffer:', buffer);
	   }, [])
	   const storeBufferThreshold = useRef(10000);
	   const [graphBuffer, setGraphBuffer] = useState([])
	   const [channels, setChannels] = useState([]);

	   // Define saveData BEFORE useEffect
	   const saveData = useCallback((buffer: Array<Frame | null>, statusAtCall: STATUS) => {
		   if (buffer.length === 0) return

		   try {
			   const serialized = buffer.map(frame => frame?.serialize()).join("")
			   const dataKey = "aq_seg" + segmentRef.current

			   // Store acquisition time and channels if not already present
			   if (!(dataKey in localStorage)) {
				   const now = Date.now()
				   localStorage.setItem(dataKey + "time", JSON.stringify(now))
				   if (window.electronAPI?.sendSample) {
					   window.electronAPI.sendSample({ type: "acquisition_time", value: now })
				   }
				   const channels = deviceRef.current?.getChannels?.() || []
				   if (channels.length > 0) {
					   localStorage.setItem("aq_channels", JSON.stringify(channels))
					   if (window.electronAPI?.sendSample) {
						   window.electronAPI.sendSample({ type: "channels", value: channels })
					   }
				   }
			   }

			   // Store sample rate
			   const sampleRate = deviceRef.current?.getSamplingRate?.()
			   if (sampleRate) {
				   localStorage.setItem("aq_sampleRate", JSON.stringify(sampleRate))
				   if (window.electronAPI?.sendSample) {
					   window.electronAPI.sendSample({ type: "sample_rate", value: sampleRate })
				   }
			   }

			   localStorage.setItem(
				   dataKey,
				   (localStorage.getItem(dataKey) ?? "") + serialized
			   )

			   // Send each frame to Electron main process for chunked saving
			   if (window.electronAPI?.sendSample) {
				   buffer.forEach(frame => {
					   window.electronAPI.sendSample({ type: "frame", value: frame })
				   })
			   }

			   // Flush samples on stop/pause
			   if ((statusAtCall === STATUS.PAUSED || statusAtCall === STATUS.STOPPED) && window.electronAPI?.flushSamples) {
				   window.electronAPI.flushSamples(true)
			   } else if (window.electronAPI?.flushSamples) {
				   window.electronAPI.flushSamples()
			   }
		   } catch (e) {
			   if (e instanceof DOMException && e.name === "QuotaExceededError") {
				   setStatus(STATUS.OUT_OF_STORAGE)
				   if (window.electronAPI?.flushSamples) {
					   window.electronAPI.flushSamples()
				   }
				   if (deviceRef.current){
					deviceRef.current.onError = () => {}
				   	deviceRef.current.disconnect?.().finally(() => {})
				   }
				   return
			   }
			   console.error(e)
			   throw e
		   }
	   }, [])

	   // Subscribe to framePublisher for UI and storage updates
	   useEffect(() => {
		   const unsubscribeUI = registerUISubscriber(
			   () => deviceRef.current?.getSamplingRate?.() || 1000,
			   ({ graphBuffer, xDomain, channels, acquisitionStarted }) => {
				   setGraphBuffer(graphBuffer)
				   setXDomain(xDomain)
				   setChannels(channels)
				   setAcquisitionStarted(acquisitionStarted)
			   }
		   )

		   const unsubscribeStorage = registerStorageSubscriber(
			   () => storeBufferThreshold.current,
			   buffer => {
				   if (buffer.length === 0) return
				   saveData(buffer, statusRef.current)
			   }
		   )

		   const unsubscribeProcessing = registerProcessingSubscriber(
			   () => processingBufferLimit.current,
			   processFrame
		   )

		   return () => {
			   unsubscribeUI?.()
			   unsubscribeStorage?.()
			   unsubscribeProcessing?.()
		   }
	   }, [processFrame, saveData])

   // Send initial buffer size to Electron
   useEffect(() => {
	   if (window.electronAPI && storeBufferThreshold.current) {
		   if (window.electronAPI.setBufferSize) {
			   window.electronAPI.setBufferSize(storeBufferThreshold.current);
		   }
	   }
   }, []);

   // Send buffer size to Electron whenever it changes
   useEffect(() => {
	   if (window.electronAPI && storeBufferThreshold.current) {
		   if (window.electronAPI.setBufferSize) {
			   window.electronAPI.setBufferSize(storeBufferThreshold.current);
		   }
	   }
   }, [storeBufferThreshold.current]);
	const router = useRouter()
	const deviceRef = useRef<Device | null>(null)
	const [status, setStatus] = useState(STATUS.DISCONNECTED)
	// Determines whether an acquisition has started or not. If an acquisiton
	// has started, a download button will be shown if the acquistion fails.
	const [acquisitionStarted, setAcquisitionStarted] = useState(false)
	const segmentRef = useRef(1)
	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null)

	const channelsRef = useRef<string[]>([])
	const isDark = useDarkTheme()
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0])

	// The following useEffect ensures that the device is disconnected when the
	// user leaves the page
	useEffect(() => {
		return () => {
			if (deviceRef.current) {
				deviceRef.current.disconnect().catch(() => {
					// Ignore any errors. We are already leaving the page
				})
			}
		}
	}, [])

	const statusRef = useRef(status)
	useEffect(() => {
	statusRef.current = status
	}, [status])

	const connect = useCallback(async () => {
		setStatus(STATUS.CONNECTING)
		setAcquisitionStarted(false)

		// Read settings from local storage
		const settings = JSON.parse(
			localStorage.getItem("settings") || "{}"
		) as Record<string, unknown>

		switch (settings.deviceType ?? "sense") {
			case "maker":
				const baudRate = (settings.baudRate ?? 9600) as number
				deviceRef.current = new Maker(baudRate)

				// Set the initial threshold for maker
				storeBufferThreshold.current = 200

				break
			case "sense":
				const communicationMode = (settings.communication ??
					SCIENTISST_COMUNICATION_MODE.WEBSERIAL) as SCIENTISST_COMUNICATION_MODE
				const channels = (settings.channels ?? [
					"AI1",
					"AI2",
					"AI3",
					"AI4",
					"AI5",
					"AI6"
				]) as SCIENTISST_CHANNEL[]
				const samplingRate = (settings.samplingRate ?? 1000) as number

				deviceRef.current = new ScientISST(
					communicationMode,
					new Set(channels),
					samplingRate
				)

				// Set the initial save threshold for ScientISST to 10 seconds
				storeBufferThreshold.current = samplingRate * 5

				break
			default:
				setStatus(STATUS.CONNECTION_FAILED)
				throw new Error("Device type not supported.")
		}

		try {
			await deviceRef.current.connect()
			segmentRef.current = 1
			setFirmwareVersion(
				deviceRef.current.getFirmwareVersion()
					? deviceRef.current.getFirmwareVersion().version
					: null
			)
			setStatus(STATUS.CONNECTED)
		} catch (error) {
			console.error(error)
			if (error instanceof CancelledByUserException) {
				setStatus(STATUS.DISCONNECTED)
				return
			}

			setStatus(STATUS.CONNECTION_FAILED)
		}
	}, [])

	const disconnect = useCallback(async () => {
		framePublisher.reset()
		await deviceRef.current?.disconnect()
		deviceRef.current = null
		setStatus(STATUS.DISCONNECTED)
	}, [])

	const start = useCallback(async () => {
		try {
			framePublisher.reset()
			framePublisher.startSession({ startedAt: Date.now() })
			console.log("[START]")
			window.electronAPI?.startAcquisition?.(new Date().toISOString())
			window.electronAPI?.setBufferSize?.(storeBufferThreshold.current)
			
			// cleanup all localstorage items that start with aq_
			for (const key in localStorage) {
				if (key.startsWith("aq_")) {
					localStorage.removeItem(key)
				}
			}

			// Save device type and ADC characteristics to localStorage
			localStorage.setItem(
				"aq_deviceType",
				deviceRef.current instanceof Maker ? "maker" : "sense"
			)

			const adcCharacteristics =
				deviceRef.current?.getAdcCharacteristics()

			if (adcCharacteristics !== null) {
				localStorage.setItem("aq_adcChars", adcCharacteristics.toJSON())
			}

			// Save the total number of segments to localStorage.
			// This is going to start at zero because we are starting the
			// first acquisition.
			localStorage.setItem(
				"aq_segments",
				JSON.stringify(segmentRef.current)
			)

			deviceRef.current.onFrames = data => {
				if (data == null) return
				if (Array.isArray(data)) {
					framePublisher.publishFrames(data.filter(Boolean))
				} else {
					framePublisher.publishFrame(data)
				}
			}

			deviceRef.current.onError = e => {
				console.error(e)
				setStatus(STATUS.CONNECTION_LOST)
			}

			// Removed: storeBufferRef reset

			// Reset the list of channels being acquired so it can be filled
			// again with the channels from the new acquisition.
			channelsRef.current = []

			await deviceRef.current?.startAcquisition()
			// Electron acquisition start is already called above, do not repeat here
			setStatus(STATUS.ACQUIRING)
		} catch (error) {
			console.error(error)
			setStatus(STATUS.CONNECTION_LOST)
		}
	}, [])

	const stop = useCallback(async () => {
		   deviceRef.current.onError = () => {
			   // We are already stopping and disconnecting the device, we don't
			   // really care about errors from this point onwards.
		   }
		   setStatus(STATUS.STOPPING)
		   try {
			   framePublisher.stopSession()
			   framePublisher.reset()
			   console.log("[STOP]")
			   window.electronAPI?.flushSamples?.(true)
			   await deviceRef.current?.stopAcquisition()
			   await deviceRef.current?.disconnect()
			   deviceRef.current = null
		   } catch (e) {
			   // Ignore the errors. See the comment in the onError handler above.
		   }
		   // Save remaining data, update status, and redirect
		   saveData(graphBuffer, STATUS.STOPPED)
		   setStatus(STATUS.STOPPED_AND_SAVED)
		   router.push("/summary", {}).then(() => {
			   // Ignore
		   })
	}, [])

	const pause = useCallback(async () => {
		   deviceRef.current.onError = () => {
			   // We are pausing the acquisition, if an error occurs we will handle
			   // it in the catch block below.
		   }
		   try {
			   framePublisher.reset()
			   console.log("[PAUSE]")
			   await deviceRef.current?.stopAcquisition()
			   // Electron: flush and finalize segment
			   window.electronAPI?.flushSamples?.(true)
			   setStatus(STATUS.PAUSED)
		   } catch (e) {
			   setStatus(STATUS.CONNECTION_LOST)
		   }
	}, [])

	const resume = useCallback(async () => {
		deviceRef.current.onError = e => {
			console.error(e)
			deviceRef.current?.disconnect().finally(() => {
				deviceRef.current = null
				setStatus(STATUS.CONNECTION_LOST)
			})
		}

		try {
			// Increment segment number for new segment
			segmentRef.current += 1

			// Reset charts
			setGraphBuffer([])
			setXDomain([0, 0])
			// Removed: graphBufferRef, frameSequenceRef

			// Electron: start new acquisition segment with new timestamp
			if (window.electronAPI?.startAcquisition) {
				window.electronAPI.startAcquisition(new Date().toISOString())
			}

			console.log("[RESUME]")
			await deviceRef.current?.startAcquisition()
			setStatus(STATUS.ACQUIRING)

			// Update localStorage with new segment number
			localStorage.setItem(
				"aq_segments",
				JSON.stringify(segmentRef.current)
			)
		} catch (e) {
			setStatus(STATUS.CONNECTION_LOST)
		}
	}, [])

	const xTickFormatter = useCallback((value: number) => {
		const samplingRate = deviceRef.current?.getSamplingRate()
		const time = samplingRate !== 0 ? value / samplingRate : value
		if (time < 0) {
			return "0:00"
		}

		const seconds = Math.floor(time % 60)
		const minutes = Math.floor(time / 60)

		if (seconds < 10) {
			return `${minutes}:0${seconds}`
		}
		return `${minutes}:${seconds}`
	}, [])

	return (
		<SenseLayout
			className="container flex flex-col items-center justify-start gap-4 p-8"
			title="Live Acquisition"
			shortTitle="Live"
			returnHref="/"
		>
			{status === STATUS.CONNECTED && firmwareVersion !== null && (
				<span>Firmware Version: {firmwareVersion}</span>
			)}
			<div className="flex flex-row gap-4">
				{(status === STATUS.DISCONNECTED ||
					status === STATUS.CONNECTING ||
					status === STATUS.CONNECTION_FAILED ||
					(status === STATUS.CONNECTION_LOST &&
						!acquisitionStarted)) && (
					<TextButton
						size={"base"}
						onClick={connect}
						disabled={status === STATUS.CONNECTING}
					>
						Connect
					</TextButton>
				)}
				{(status === STATUS.CONNECTION_LOST ||
					status === STATUS.OUT_OF_STORAGE) &&
					   acquisitionStarted && (
						   <Link href="/summary">
							   <TextButton size={"base"}>Download</TextButton>
						   </Link>
					   )}
				{status === STATUS.CONNECTED && (
					<>
						<TextButton size={"base"} onClick={start}>
							Start
						</TextButton>
						<TextButton size={"base"} onClick={disconnect}>
							Disconnect
						</TextButton>
					</>
				)}
				{(status === STATUS.ACQUIRING || status === STATUS.PAUSED) && (
					<>
						<TextButton
							size={"base"}
							onClick={status === STATUS.PAUSED ? resume : pause}
						>
							{status === STATUS.PAUSED ? "Resume" : "Pause"}
						</TextButton>
						<TextButton size={"base"} onClick={stop}>
							Stop
						</TextButton>
					</>
				)}
			</div>
			{status === STATUS.CONNECTING && (
				<span>Attempting to connect...</span>
			)}
			{status === STATUS.CONNECTION_FAILED && (
				<span>Connection failed!</span>
			)}
			{status === STATUS.CONNECTION_LOST && <span>Connection lost!</span>}
			{status === STATUS.STOPPING && <span>Stopping acquisition...</span>}
			{(status === STATUS.STOPPED ||
				status === STATUS.STOPPED_AND_SAVED) && (
				<span>Redirecting to summary page...</span>
			)}
			{status === STATUS.ACQUIRING && <span>Acquiring...</span>}
			{status === STATUS.OUT_OF_STORAGE && (
				<span>Ran out of local storage!</span>
			)}
			{status === STATUS.ACQUIRING && (
				<Formik
					initialValues={{
						channelName: channelsRef.current.reduce(
							(acc, channel) => {
								acc[channel] = channel
								return acc
							},
							{} as Record<number, string>
						)
					}}
					onSubmit={async values => {
						const { channelName } = values

						localStorage.setItem(
							"aq_channelNames",
							JSON.stringify(channelName)
						)
					}}
				>
					<Form className="flex w-full flex-col gap-4">
						<FormikAutoSubmit delay={100} />
						{channels.map(channel => {
							return (
								<Fragment key={channel}>
									<div className="flex w-full flex-row">
										<TextField
											id={`channelName.${channel}`}
											name={`channelName.${channel}`}
											className="mb-0"
											placeholder={channel}
										/>
									</div>
									<div className="bg-background-accent flex w-full flex-col rounded-md">
										<div className="w-full p-4">
											<CanvasChart
												data={graphBuffer.map(
													x => [
														x[0],
														x[1].channels[channel]
													]
												)}
												xMin={xDomain[0]}
												xMax={xDomain[1]}
												className="h-64 w-full"
												fontFamily="Lexend"
												lineColor={
													isDark
														? lineColorDark
														: lineColorLight
												}
												outlineColor={
													isDark
														? outlineColorDark
														: outlineColorLight
												}
												yTicks={5}
												xTicks={5}
												xTickFormat={xTickFormatter}
											/>
										</div>
									</div>
								</Fragment>
							)
						})}
					</Form>
				</Formik>
			)}
		</SenseLayout>
	)
}

export default Page
