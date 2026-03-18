import React, {
	Fragment,
	useCallback,
	useEffect,
	useRef,
	useState
} from "react"

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

import { framePublisher } from "../../../sense-desktop/src/FramePublisher"
import { BufferManager } from "../../../sense-desktop/src/BufferManager"
import { SignalProcessor } from "../../../sense-desktop/src/SignalProcessor"
import { onUIBufferUpdated } from '../../../sense-desktop/src/UISubscriber';
import { onChunkReady } from '../../../sense-desktop/src/StorageSubscriber';
import { onProcessingWindow } from '../../../sense-desktop/src/ProcessingSubscriber';

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
const outlineColorDark =
	fullConfig.theme.colors["over-background-highest-dark"]

declare global {
	interface Window {
		electronAPI?: {
			sendSample?: (sample: any) => void
			setBufferSize?: (size: number) => void
			startAcquisition?: (timestamp: string) => void
			flushSamples?: (finalize?: boolean) => void
			writeChunk?: (chunk: any) => void
			finalizeSession?: () => void
		}
	}
}

type UIUpdatePayload = {
	graphBuffer: Array<[number, Frame]>
	xDomain: [number, number]
	channels: string[]
	acquisitionStarted: boolean
}

const Page = () => {
		// Track all segments for summary export
		const allSegmentsRef = useRef<any[][]>([]);
	// Accumulates all frames for the current segment for summary export
	const fullSessionFramesRef = useRef<any[]>([]);
	const storeBufferThresholdRef = useRef(10000);
	// Track last chunk flush time and threshold for dynamic adjustment
	const [lastChunkSaveTime, setLastChunkSaveTime] = useState<number | null>(null);
	const [dynamicChunkThreshold, setDynamicChunkThreshold] = useState<number>(storeBufferThresholdRef.current);

	const router = useRouter()
	const isDark = useDarkTheme()

	const deviceRef = useRef<Device | null>(null)
	const bufferManagerRef = useRef<BufferManager | null>(null)

	const subscriptionsRef = useRef<Array<() => void>>([])
	const segmentRef = useRef(1)
	const uiWindowSecondsRef = useRef(5)
	const processingWindowSecondsRef = useRef(5)

	const [status, setStatus] = useState(STATUS.DISCONNECTED)
	const statusRef = useRef(status)

	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null)
	const [acquisitionStarted, setAcquisitionStarted] = useState(false)
	const graphBufferRef = useRef<Array<[number, Frame]>>([])
	const [graphBuffer, setGraphBuffer] = useState<Array<[number, Frame]>>([])
	const channelsRef = useRef<string[]>([])
	const [channels, setChannels] = useState<string[]>([])
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0])

	useEffect(() => {
		statusRef.current = status
	}, [status])

	// Listen for chunk write completion and update chunk threshold
	useEffect(() => {
		if (window.electronAPI?.onChunkWriteComplete) {
			const unsubscribe = window.electronAPI.onChunkWriteComplete((saveTime: number) => {
				bufferManagerRef.current?.updateChunkThreshold?.(saveTime);
			});
			return unsubscribe;
		}
	}, []);

	// Helper to save current segment to localStorage
	const saveCurrentSegment = useCallback(() => {
		const segment = segmentRef.current;
		const allFrames = fullSessionFramesRef.current;
		if (allFrames && allFrames.length > 0) {
			// Serialize frames (assume Frame has serialize method, else JSON.stringify)
			const serialized = allFrames.map(frame => {
				// If frame is a [seq, frame] tuple, use frame[1]
				const f = Array.isArray(frame) && frame.length === 2 && frame[1]?.channels ? frame[1] : frame;
				return f?.serialize ? f.serialize() : JSON.stringify(f);
			}).join("");
			localStorage.setItem(`aq_seg${segment}`, serialized);
			localStorage.setItem(`aq_seg${segment}time`, JSON.stringify(Date.now()));
		}
		// Save channels
		const device = deviceRef.current;
		const channels = device?.getChannels?.() ?? channelsRef.current;
		if (channels.length > 0) {
			localStorage.setItem("aq_channels", JSON.stringify(channels));
		}
		// Save sample rate
		const sampleRate = device?.getSamplingRate?.() || 1000;
		localStorage.setItem("aq_sampleRate", JSON.stringify(sampleRate));
		// Save segments
		localStorage.setItem("aq_segments", JSON.stringify(segment));
		// Save device type
		localStorage.setItem("aq_deviceType", device instanceof Maker ? "maker" : "sense");
	}, [deviceRef, channelsRef]);

	const cleanupPipeline = useCallback(() => {
			// Clear full session buffer and all segments
			fullSessionFramesRef.current = [];
			allSegmentsRef.current = [];
		subscriptionsRef.current.forEach(unsubscribe => {
			try {
				unsubscribe?.()
			} catch {
				// ignore subscriber cleanup errors
			}
		})
		subscriptionsRef.current = []

		// Reset BufferManager state
		if (bufferManagerRef.current) {
			bufferManagerRef.current.reset?.();
		}
		bufferManagerRef.current = null;

		// Reset all local UI state
		setGraphBuffer([]);
		setChannels([]);
		setXDomain([0, 0]);
		setAcquisitionStarted(false);
	}, [])

	const handleUIUpdate = useCallback((payload: UIUpdatePayload) => {
		graphBufferRef.current = payload.graphBuffer ?? [];
		setGraphBuffer(graphBufferRef.current);

		// Use channels from payload (now always extracted in UISubscriber)
		channelsRef.current = payload.channels ?? [];
		setChannels(channelsRef.current);

		setXDomain(payload.xDomain ?? [0, 0]);
		setAcquisitionStarted(Boolean(payload.acquisitionStarted));
	}, [])

	const writeChunkToElectron = useCallback(
		(chunk: any) => {
			if (!chunk) return;
			try {
				if (window.electronAPI?.writeChunk) {
					window.electronAPI.writeChunk(chunk);
				} else if (window.electronAPI?.sendSample) {
					// Support chunk objects with .frames property
					const frames = Array.isArray(chunk?.frames) ? chunk.frames : (Array.isArray(chunk) ? chunk : []);
					frames.forEach(frame => {
						window.electronAPI?.sendSample?.({ type: "frame", value: frame });
					});
					window.electronAPI?.flushSamples?.();
				}
			} catch (error) {
				console.error(error);
				setStatus(STATUS.OUT_OF_STORAGE);
			}
		},
		[]
	);

	const initializePipeline = useCallback(
		(sampleRate: number) => {
			cleanupPipeline();
			// Instantiate BufferManager with options if needed
			bufferManagerRef.current = new BufferManager({
				uiWindowSize: uiWindowSecondsRef.current * sampleRate,
				processingWindowSize: processingWindowSecondsRef.current * sampleRate,
				chunkSize: storeBufferThresholdRef.current
			});
			// Subscribe BufferManager to framePublisher
			const unsubscribePublisher = framePublisher.subscribeFrame(frame => {
				bufferManagerRef.current?.ingest(frame);
			});

			// Subscribe to UI updates
			const unsubscribeUI = bufferManagerRef.current?.subscribeUI(bufferWindow => {
				onUIBufferUpdated(bufferWindow, handleUIUpdate);
			});
			// Subscribe to storage chunk updates
			const unsubscribeStorage = bufferManagerRef.current?.subscribeStorage(chunk => {
				onChunkReady(chunk, chunk => {
					writeChunkToElectron(chunk);
				});
			});
			// Subscribe to processing window updates using ProcessingSubscriber adapter
			const unsubscribeProcessing = bufferManagerRef.current?.subscribeProcessing(window => {
				onProcessingWindow(
					window,
					{
						process: SignalProcessor.extractFeatures
					},
					results => {
						// Optionally handle derived results
					}
				);
			});
			subscriptionsRef.current = [
				unsubscribePublisher,
				unsubscribeUI,
				unsubscribeStorage,
				unsubscribeProcessing
			];
		},
		[cleanupPipeline, handleUIUpdate, writeChunkToElectron]
	);

	const clearAcquisitionLocalState = useCallback(() => {
		setGraphBuffer([])
		setChannels([])
		setXDomain([0, 0])
		setAcquisitionStarted(false)

		for (const key in localStorage) {
			if (key.startsWith("aq_")) {
				localStorage.removeItem(key)
			}
		}
	}, [])

	const persistSessionMetadata = useCallback(() => {
		const device = deviceRef.current
		if (!device) return

		localStorage.setItem(
			"aq_deviceType",
			device instanceof Maker ? "maker" : "sense"
		)

		const adcCharacteristics = device.getAdcCharacteristics?.()
		if (adcCharacteristics !== null && adcCharacteristics !== undefined) {
			localStorage.setItem("aq_adcChars", adcCharacteristics.toJSON())
		}

		localStorage.setItem("aq_segments", JSON.stringify(segmentRef.current))

		const samplingRate = device.getSamplingRate?.()
		if (samplingRate) {
			localStorage.setItem("aq_sampleRate", JSON.stringify(samplingRate))
		}

		const currentChannels = device.getChannels?.() ?? []
		if (currentChannels.length > 0) {
			localStorage.setItem("aq_channels", JSON.stringify(currentChannels))
		}
	}, [])

	const connect = useCallback(async () => {
		setStatus(STATUS.CONNECTING)
		setAcquisitionStarted(false)
		cleanupPipeline(); // Reset all state and BufferManager before connect

		const settings = JSON.parse(
			localStorage.getItem("settings") || "{}"
		) as Record<string, unknown>

		try {
			switch (settings.deviceType ?? "sense") {
				case "maker": {
					const baudRate = (settings.baudRate ?? 9600) as number
					deviceRef.current = new Maker(baudRate)
					storeBufferThresholdRef.current = 200
					break
				}

				case "sense": {
					const communicationMode = (settings.communication ??
						SCIENTISST_COMUNICATION_MODE.WEBSERIAL) as SCIENTISST_COMUNICATION_MODE
					const selectedChannels = (settings.channels ?? [
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
						new Set(selectedChannels),
						samplingRate
					)

					storeBufferThresholdRef.current = samplingRate * 5
					break
				}

				default:
					throw new Error("Device type not supported.")
			}

			await deviceRef.current.connect()

			segmentRef.current = 1
			setFirmwareVersion(
				deviceRef.current.getFirmwareVersion?.()
					? deviceRef.current.getFirmwareVersion()?.version ?? null
					: null
			)

			window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current)
			setStatus(STATUS.CONNECTED)
		} catch (error) {
			console.error(error)

			if (error instanceof CancelledByUserException) {
				setStatus(STATUS.DISCONNECTED)
				return
			}

			deviceRef.current = null
			setStatus(STATUS.CONNECTION_FAILED)
		}
	}, [cleanupPipeline])

	const disconnect = useCallback(async () => {
		try {
			framePublisher.reset();
			cleanupPipeline();
			await deviceRef.current?.disconnect?.();
		} catch {
			// ignore disconnect errors
		} finally {
			deviceRef.current = null;
			setStatus(STATUS.DISCONNECTED);
		}
	}, [cleanupPipeline])

	const start = useCallback(async () => {
		const device = deviceRef.current
		if (!device) return

		try {
			cleanupPipeline(); // Reset all state and BufferManager before start

			const sampleRate = device.getSamplingRate?.() || 1000;
			initializePipeline(sampleRate);

			bufferManagerRef.current?.startSession({
				startedAt: Date.now(),
				sampleRate,
				segment: segmentRef.current
			});

			window.electronAPI?.startAcquisition?.(new Date().toISOString());
			window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current);

			persistSessionMetadata();

			device.onFrames = data => {
				if (data == null) return;
				// Always pass every frame to BufferManager via framePublisher
				if (Array.isArray(data)) {
					const validFrames = data.filter(Boolean);
					framePublisher.publishFrames(validFrames);
					// Accumulate all frames for summary export
					fullSessionFramesRef.current.push(...validFrames);
				} else {
					framePublisher.publishFrame(data);
					fullSessionFramesRef.current.push(data);
				}
			}            

			device.onError = error => {
				console.error(error);
				setStatus(STATUS.CONNECTION_LOST);
			};

			await device.startAcquisition?.();
			setStatus(STATUS.ACQUIRING);
		} catch (error) {
			console.error(error);
			setStatus(STATUS.CONNECTION_LOST);
		}
	}, [cleanupPipeline, initializePipeline, persistSessionMetadata])

	const pause = useCallback(async () => {
		if (!deviceRef.current) return

		deviceRef.current.onError = () => {
			// ignore during controlled pause
		}

		try {
			await deviceRef.current.stopAcquisition?.();
			bufferManagerRef.current?.flushChunk?.(true);
			// Save current segment before resetting for next
			saveCurrentSegment();
			// Track segment for summary export
			if (fullSessionFramesRef.current.length > 0) {
				allSegmentsRef.current.push([...fullSessionFramesRef.current]);
			}
			// Reset full session buffer for next segment
			fullSessionFramesRef.current = [];
			setStatus(STATUS.PAUSED);
		} catch (error) {
			console.error(error);
			setStatus(STATUS.CONNECTION_LOST);
		}
	}, [])

	const resume = useCallback(async () => {
			// Reset full session buffer for new segment (already saved at pause)
			fullSessionFramesRef.current = [];
		if (!deviceRef.current) return

		deviceRef.current.onError = error => {
			console.error(error)
			deviceRef.current?.disconnect?.().finally(() => {
				deviceRef.current = null
				setStatus(STATUS.CONNECTION_LOST)
			})
		}

		try {
			segmentRef.current += 1;
			
			setGraphBuffer([]);
			setChannels([]);
			setXDomain([0, 0]);
			setAcquisitionStarted(false);

			bufferManagerRef.current?.reset();
			bufferManagerRef.current?.startSession({
				startedAt: Date.now(),
				sampleRate: deviceRef.current.getSamplingRate?.() || 1000,
				segment: segmentRef.current
			})

			window.electronAPI?.startAcquisition?.(new Date().toISOString())
			localStorage.setItem("aq_segments", JSON.stringify(segmentRef.current))

			await deviceRef.current.startAcquisition?.()
			setStatus(STATUS.ACQUIRING)
		} catch (error) {
			console.error(error)
			setStatus(STATUS.CONNECTION_LOST)
		}
	}, [])

	const stop = useCallback(async () => {
		if (!deviceRef.current) return

		deviceRef.current.onError = () => {
			// ignore while stopping
		}

		setStatus(STATUS.STOPPING)

		try {
			await deviceRef.current.stopAcquisition?.()
		} catch {
			// ignore
		}

		try {
			bufferManagerRef.current?.stopSession();
		} catch {
			// ignore
		}

		try {
			await deviceRef.current.disconnect?.()
		} catch {
			// ignore
		}

		// Save all segments before cleanup
		try {
			// Save current segment if not already tracked
			if (fullSessionFramesRef.current.length > 0) {
				allSegmentsRef.current.push([...fullSessionFramesRef.current]);
			}
			// Save each segment to localStorage
			allSegmentsRef.current.forEach((segmentFrames, idx) => {
				// Temporarily set segmentRef for saveCurrentSegment
				segmentRef.current = idx + 1;
				fullSessionFramesRef.current = segmentFrames;
				saveCurrentSegment();
			});
		} catch (e) {
			// Ignore errors
		}
		deviceRef.current = null;
		cleanupPipeline();
		window.electronAPI?.finalizeSession?.();

		setStatus(STATUS.STOPPED_AND_SAVED);
		router.push("/summary", {}).then(() => {
			// Ignore
		});
	}, [cleanupPipeline, router])

	useEffect(() => {
		return () => {
			cleanupPipeline()
			deviceRef.current?.disconnect?.().catch(() => {
				// ignore cleanup errors
			})
		}
	}, [cleanupPipeline])

	const xTickFormatter = useCallback((value: number) => {
		const samplingRate = deviceRef.current?.getSamplingRate?.() || 1
		const time = samplingRate !== 0 ? value / samplingRate : value

		if (time < 0) return "0:00"

		const seconds = Math.floor(time % 60)
		const minutes = Math.floor(time / 60)

		return seconds < 10 ? `${minutes}:0${seconds}` : `${minutes}:${seconds}`
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
						channelName: channels.reduce(
							(acc, channel) => {
							acc[channel] = channel
							return acc
							},
							{} as Record<string, string>
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