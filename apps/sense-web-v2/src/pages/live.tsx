import React, {
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState
	} from "react"

import { framePublisher } from "../../../../packages/esptool-js/src/FramePublisher"

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
if (window.electronAPI) {
    // Send samples to main process for disk storage
	function saveSampleToDisk(sample: any) {
		window.electronAPI.sendSample(sample);
    }
    electronSampleWriter = { addSample: saveSampleToDisk }
}

const Page = () => {
	const storeBufferThreshold = useRef(10000);

	// Subscribe to framePublisher for UI and storage updates
	useEffect(() => {
		const handleFrame = (frame: any) => {
			// UI: update graph buffer
			graphBufferRef.current.push([
				frameSequenceRef.current,
				frame
			])
			const graphBufferLimit = Math.ceil(
				deviceRef.current?.getSamplingRate?.() * 5 || 5000
			)
			if (graphBufferRef.current.length > graphBufferLimit) {
				graphBufferRef.current.shift()
			}
			frameSequenceRef.current++
			setXDomain([
				frameSequenceRef.current - graphBufferLimit,
				frameSequenceRef.current
			])

			// Storage: queue frame for saving
			storeBufferRef.current.push(frame)
			if (storeBufferRef.current.length >= storeBufferThreshold.current) {
				setStoreBufferLength(storeBufferRef.current.length)
			}
			if (channelsRef.current.length === 0 && frame.channels) {
				channelsRef.current = Object.keys(frame.channels).sort()
			}
			setAcquisitionStarted(true)
		}
		framePublisher.on('frame', handleFrame)
		return () => {
			framePublisher.off('frame', handleFrame)
		}
	}, [])

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
	// Store buffer contains the frames that are queued to be saved to
	// localStorage
	const storeBufferRef = useRef<Frame[]>([])
	const [storeBufferLength, setStoreBufferLength] = useState(0)
	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null)

	const channelsRef = useRef<string[]>([])
	const isDark = useDarkTheme()
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0])
	const graphBufferRef = useRef<[number, Frame][]>([])
	const frameSequenceRef = useRef(0)

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

	// This function stored all queued frames to localStorage
	const saveData = useCallback((buffer: Array<Frame | null>, statusAtCall: STATUS) => {
		if (buffer.length === 0) return

		try {
			const serialized = buffer.map(frame => frame?.serialize()).join("")

			const dataKey = "aq_seg" + segmentRef.current

			if (!(dataKey in localStorage)) {
				localStorage.setItem(
					dataKey + "time",
					JSON.stringify(Date.now())
				);
				// Also send to chunked writer
				if (electronSampleWriter) {
					electronSampleWriter.addSample({ type: "acquisition_time", value: Date.now() });
				}
				const channels = deviceRef.current?.getChannels();
				if (channels) {
					localStorage.setItem(
						"aq_channels",
						JSON.stringify(channels)
					);
					// Also send to chunked writer
					if (electronSampleWriter) {
						electronSampleWriter.addSample({ type: "channels", value: channels });
					}
				}
			}

			const sampleRate = deviceRef.current?.getSamplingRate();
			if (sampleRate) {
				localStorage.setItem(
					"aq_sampleRate",
					JSON.stringify(sampleRate)
				);
				// Also send to chunked writer
				if (electronSampleWriter) {
					electronSampleWriter.addSample({ type: "sample_rate", value: sampleRate });
				}
			}

			localStorage.setItem(
				dataKey,
				(localStorage.getItem(dataKey) ?? "") + serialized
			);

			// Send each frame to Electron main process for chunked saving
			if (electronSampleWriter) {
				buffer.forEach(frame => {
					electronSampleWriter.addSample({ type: "frame", value: frame });
				});
			}

			if ((statusAtCall === STATUS.PAUSED || statusAtCall === STATUS.STOPPED) && window.electronAPI && window.electronAPI.flushSamples) {
				window.electronAPI.flushSamples(true); // finalize = true
			}else if (window.electronAPI && window.electronAPI.flushSamples) {
				window.electronAPI.flushSamples();
			}
			storeBufferRef.current = [];
			setStoreBufferLength(storeBufferRef.current.length); // Prevent state loops
		} catch (e) {
			if (e instanceof DOMException && e.name === "QuotaExceededError") {
				// We are out of localStorage, show the user the error
				setStatus(STATUS.OUT_OF_STORAGE)
				// Tell Electron to flush its buffer at session end
				if (window.electronAPI && window.electronAPI.flushSamples) {
					window.electronAPI.flushSamples();
				}
				storeBufferRef.current = []
				setStoreBufferLength(storeBufferRef.current.length) // Prevent state loops

				// Disconnect from the device, we can't continue the acquisition
				deviceRef.current.onError = () => {
					// We don't care about errors any more, we can't save
					// any new date regardless.
				}
				deviceRef.current.disconnect().finally(() => {
					// Ignore
				})
				return
			}

			console.error(e)
			throw e
		}
	}, [])

	// Save data to local storage
	useEffect(() => {
		if (storeBufferLength >= storeBufferThreshold.current) {
			const start = Date.now();
			saveData(storeBufferRef.current, status);
			const saveTime = Date.now() - start;

			console.log("Saved data in " + saveTime + "ms");

			const sampleRate = deviceRef.current?.getSamplingRate();
			storeBufferThreshold.current = Math.max(
				sampleRate * 5,
				Math.min(
					sampleRate * (saveTime / 1000 / 0.005),
					sampleRate * 10
				)
			);

			console.log("Save threshold: " + storeBufferThreshold.current);
		} else if (status === STATUS.PAUSED) {
			saveData(storeBufferRef.current, status);
		} else if (status === STATUS.STOPPED) {
			saveData(storeBufferRef.current, status)
			setStatus(STATUS.STOPPED_AND_SAVED)
			router.push("/summary", {}).then(() => {
				// Ignore
			})
		}
	}, [router, saveData, status, storeBufferLength])

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
		await deviceRef.current?.disconnect()
		deviceRef.current = null
		setStatus(STATUS.DISCONNECTED)
	}, [])

	const start = useCallback(async () => {
		try {
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
				if (data === null) return;
				// Publish each parsed frame via FramePublisher
				if (Array.isArray(data)) {
				  data.forEach(frame => {
					if (frame) framePublisher.publishFrame(frame)
				  })
				} else if (data) {
				  framePublisher.publishFrame(data)
				}
			}

			deviceRef.current.onError = e => {
				console.error(e)
				setStatus(STATUS.CONNECTION_LOST)
			}

			// Ensure we don't store frames from previous acquisitions
			storeBufferRef.current = []
			setStoreBufferLength(storeBufferRef.current.length)

			// Reset the list of channels being acquired so it can be filled
			// again with the channels from the new acquisition.
			channelsRef.current = []

			await deviceRef.current?.startAcquisition()
			// Send startAcquisition IPC event to Electron main process ONCE per session
			if (window.electronAPI && window.electronAPI.startAcquisition) {
				window.electronAPI.startAcquisition(new Date().toISOString())
			}
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
			await deviceRef.current?.stopAcquisition()
			await deviceRef.current?.disconnect()
			deviceRef.current = null
		} catch (e) {
			// Ignore the errors. See the comment in the onError handler above.
		}
		setStatus(STATUS.STOPPED)
	}, [])

	const pause = useCallback(async () => {
		deviceRef.current.onError = () => {
			// We are pausing the acquisition, if an error occurs we will handle
			// it in the catch block below.
		}
		try {
			await deviceRef.current?.stopAcquisition()
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
			// We need to increment the segment number because we are starting
			// a new acquisition. This way the data will be saved in a different
			// localStorage entry.
			//
			// We do this before starting the acquisition to ensure that new
			// data will not be saved in the previous segment.
			segmentRef.current += 1

			// Ensure we don't store frames from previous acquisitions
			storeBufferRef.current = []
			setStoreBufferLength(storeBufferRef.current.length)

			// Reset charts
			graphBufferRef.current = []
			setXDomain([0, 0])
			frameSequenceRef.current = 0

			await deviceRef.current?.startAcquisition()
			// Send startAcquisition IPC event to Electron main process ONCE per session
			if (window.electronAPI && window.electronAPI.startAcquisition) {
				window.electronAPI.startAcquisition(new Date().toISOString())
			}
			setStatus(STATUS.ACQUIRING)

			// Now that acquisition has started, we need to update the
			// localStorage entry with the new segment number.
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
						{channelsRef.current.map(channel => {
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
												data={graphBufferRef.current.map(
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
