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
import { onChunkReady } from '../../../sense-desktop/src/StorageSubscriber';
import { onProcessingWindow } from '../../../sense-desktop/src/ProcessingSubscriber';
import { SessionManager } from '../../../sense-desktop/src/SessionManager';

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


function initTestingStorageFlag() {
	if (typeof window !== 'undefined' && window.TESTING_STORAGE === undefined && typeof process !== 'undefined' && process.env && process.env.TESTING_STORAGE) {
		window.TESTING_STORAGE = process.env.TESTING_STORAGE;
	}
}

initTestingStorageFlag();

const Page = () => {
	// Track all segments for summary export (for validation only)
	const allSegmentsRef = useRef<any[][]>([]); // Only for LocalStorage validation
	// Accumulates all frames for the current segment for summary export (for validation only)
	const fullSessionFramesRef = useRef<any[]>([]); // Only for LocalStorage validation
	const storeBufferThresholdRef = useRef(10000);
	// Track last chunk flush time and threshold for dynamic adjustment

	const router = useRouter();
	const isDark = useDarkTheme();

	const deviceRef = useRef<Device | null>(null);
	const bufferManagerRef = useRef<BufferManager | null>(null);

	const subscriptionsRef = useRef<Array<() => void>>([]);
	const segmentRef = useRef(1);

	const uiWindowSecondsRef = useRef(5);
	const processingWindowSecondsRef = useRef(5);

	const [status, setStatus] = useState(STATUS.DISCONNECTED);

	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null);
	const [acquisitionStarted, setAcquisitionStarted] = useState(false);
	const acquisitionStartedRef = useRef(false);

	const graphBufferRef = useRef<Array<[number, Frame]>>([]);
	const [graphBuffer, setGraphBuffer] = useState<Array<[number, Frame]>>([]);
	const channelsRef = useRef<string[]>([]);
	const [channels, setChannels] = useState<string[]>([]);
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0]);
	const frameSequenceRef = useRef(0);

	// Save segment to LocalStorage for validation only (main persistence is chunk files)
	// Testing-only: Save segment to LocalStorage for validation
	const saveCurrentSegment = useCallback(() => {
		if (typeof process !== 'undefined' && process.env.TESTING_STORAGE === '1') {
			const segment = segmentRef.current;
			const device = deviceRef.current;
			const channels = device?.getChannels?.() ?? channelsRef.current;
			const allFrames = fullSessionFramesRef.current;
			SessionManager.saveSegmentFrames(segment, allFrames);
			if (channels.length > 0) {
				SessionManager.saveChannels(channels);
			}
			const sampleRate = device?.getSamplingRate?.() || 1000;
			SessionManager.saveSampleRate(sampleRate);
			SessionManager.saveSegmentCount(segment);
			SessionManager.saveDeviceType(device instanceof Maker ? "maker" : "sense");
		}
	}, []);

	// Throttle React state updates to requestAnimationFrame (top-level, not inside callback)
	const animationFrameRef = useRef<number | null>(null);
	// Only run RAF UI loop when acquiring or paused
	useEffect(() => {
		let running = false;
		function updateUI() {
			if (!running) return;
			setGraphBuffer([...graphBufferRef.current]);
			// Compute xDomain based on frameSequenceRef and graphBufferLimit
			const sampleRate = deviceRef.current?.getSamplingRate?.() || 1000;
			const graphBufferLimit = Math.ceil(sampleRate * (uiWindowSecondsRef.current || 5));
			setXDomain([
				frameSequenceRef.current - graphBufferLimit,
				frameSequenceRef.current
			]);
			animationFrameRef.current = requestAnimationFrame(updateUI);
		}
		if (status === STATUS.ACQUIRING || status === STATUS.PAUSED) {
			running = true;
			animationFrameRef.current = requestAnimationFrame(updateUI);
		}
		return () => {
			running = false;
			if (animationFrameRef.current !== null) {
				cancelAnimationFrame(animationFrameRef.current);
			}
		};
	}, [status]);


	useEffect(() => {
		if (!window.electronAPI?.onChunkWriteComplete) return;

		// Expect info: { saveTime: number, chunkIndex: number, final: boolean }
		const unsubscribe = window.electronAPI.onChunkWriteComplete((info: { saveTime: number, chunkIndex: number, final: boolean, filename?: string }) => {
			if (info && Number.isFinite(info.saveTime)) {
				bufferManagerRef.current?.updateChunkThreshold?.(info.saveTime);
			}
			// Append chunk record to manifest
			if (typeof SessionManager.appendChunkRecord === 'function') {
				const file = info.filename || `sample${segmentRef.current}_chunk${info.chunkIndex}.json`;
				const segment = segmentRef.current;
				SessionManager.appendChunkRecord(file, segment, info.final);
			}
		});

		return unsubscribe;
	}, []);

	useEffect(() => {
		const finalizeStop = async () => {
			if (status !== STATUS.STOPPED) return;

			try {
				// Await final chunk write completion
				const finalChunkPromise = new Promise(resolve => {
					const unsubscribe = window.electronAPI?.onChunkWriteComplete?.((info) => {
						if (info && info.final) {
							unsubscribe?.();
							resolve();
						}
					});
				});
				try {
					bufferManagerRef.current?.flushChunk?.(true);
				} catch (e) {
					console.error("[finalizeStop] flushChunk error", e);
				}
				await finalChunkPromise;

				// save current segment if needed
				if (fullSessionFramesRef.current.length > 0) {
					allSegmentsRef.current.push([...fullSessionFramesRef.current]);
				}

				// persist all segments to localStorage for validation/testing only
				if ((typeof process !== 'undefined' && process.env.TESTING_STORAGE === '1') || (typeof window !== 'undefined' && window.TESTING_STORAGE === '1')) {
					allSegmentsRef.current.forEach((segmentFrames, idx) => {
						segmentRef.current = idx + 1;
						fullSessionFramesRef.current = segmentFrames;
						saveCurrentSegment();
					});
				}

				// Finalize manifest
				await new Promise(resolve => {
					SessionManager.finalizeSession(Date.now());
					// Give a tick for manifest write to propagate
					setTimeout(resolve, 50);
				});

				try {
					window.electronAPI?.finalizeSession?.();
				} catch (e) {
					console.error("[finalizeStop] Error in finalizeSession", e);
				}

				setStatus(STATUS.STOPPED_AND_SAVED);

				await router.push("/summary");
			} catch (error) {
				console.error("[finalizeStop] Outer error", error);
				setStatus(STATUS.STOPPED_AND_SAVED);
			}
		};

		finalizeStop();
	}, [status, router, saveCurrentSegment]);

	const cleanupPipeline = useCallback(() => {
		subscriptionsRef.current.forEach(unsubscribe => {
			try {
				unsubscribe?.();
			} catch {}
		});
		subscriptionsRef.current = [];

		if (bufferManagerRef.current) {
			bufferManagerRef.current.reset?.();
		}
		bufferManagerRef.current = null;

		frameSequenceRef.current = 0;
		graphBufferRef.current = [];
		channelsRef.current = [];

		setGraphBuffer([]);
		setChannels([]);
		setXDomain([0, 0]);
		setAcquisitionStarted(false);
		acquisitionStartedRef.current = false;
	}, []);


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
			cleanupPipeline()

			frameSequenceRef.current = 0
			graphBufferRef.current = []
			channelsRef.current = []

			setGraphBuffer([])
			setChannels([])
			setXDomain([0, 0])
			setAcquisitionStarted(false)
			acquisitionStartedRef.current = false;

			bufferManagerRef.current = new BufferManager({
				uiWindowSize: uiWindowSecondsRef.current * sampleRate,
				processingWindowSize: processingWindowSecondsRef.current * sampleRate,
				chunkSize: storeBufferThresholdRef.current
			})

			// Fast UI path: direct from FramePublisher
			const unsubscribeUIPublisher = framePublisher.subscribeFrame(frame => {
				if (!frame) return;

				const graphBufferLimit = Math.ceil(
					(deviceRef.current?.getSamplingRate?.() || sampleRate) *
					uiWindowSecondsRef.current
				);

				graphBufferRef.current.push([frameSequenceRef.current, frame]);

				if (graphBufferRef.current.length > graphBufferLimit) {
					graphBufferRef.current.shift();
				}

				frameSequenceRef.current++;

				// Match live_web behavior: do not clamp to 0
				setXDomain([
					frameSequenceRef.current - graphBufferLimit,
					frameSequenceRef.current
				]);

				setGraphBuffer([...graphBufferRef.current]);

				if (channelsRef.current.length === 0 && frame.channels) {
					channelsRef.current = Object.keys(frame.channels).sort();
					setChannels([...channelsRef.current]);
				}

				if (!acquisitionStartedRef.current) {
					acquisitionStartedRef.current = true;
					setAcquisitionStarted(true);
				}
			});

			// Storage + processing path: through BufferManager
			const unsubscribeBufferManagerPublisher = framePublisher.subscribeFrame(frame => {
				bufferManagerRef.current?.ingest(frame)
			})

			const unsubscribeStorage = bufferManagerRef.current?.subscribeStorage(chunk => {
				onChunkReady(chunk, chunk => {
					console.log("[onChunkReady] writing chunk to electron: ", chunk && Array.isArray(chunk.frames) && chunk.frames.length > 0);
					if (chunk && Array.isArray(chunk.frames) && chunk.frames.length > 0) {
						writeChunkToElectron(chunk)
					}
				})
			})

			const unsubscribeProcessing = bufferManagerRef.current?.subscribeProcessing(
				window => {
					onProcessingWindow(
						window,
						{
							process: SignalProcessor.extractFeatures
						},
						_results => {
							// optionally handle results
						}
					)
				}
			)

			subscriptionsRef.current = [
				unsubscribeUIPublisher,
				unsubscribeBufferManagerPublisher,
				unsubscribeStorage,
				unsubscribeProcessing
			].filter(Boolean) as Array<() => void>
		},
		[cleanupPipeline, writeChunkToElectron]
	)

	const persistSessionMetadata = useCallback(() => {
		const device = deviceRef.current;
		if (!device) return;

			   // Update manifest/session.json (session metadata) via SessionManager only
			   SessionManager.updateSessionMeta({
				   segment: segmentRef.current,
				   channels: device.getChannels?.() ?? [],
				   sampleRate: device.getSamplingRate?.() || 1000,
				   deviceType: device instanceof Maker ? "maker" : "sense",
				   timestamp: Date.now()
			   });

		// For validation/testing: only write to LocalStorage if TESTING_STORAGE=1
		if (typeof process !== 'undefined' && process.env.TESTING_STORAGE === '1') {
			SessionManager.saveDeviceType(device instanceof Maker ? "maker" : "sense");
			const adcCharacteristics = device.getAdcCharacteristics?.();
			if (adcCharacteristics !== null && adcCharacteristics !== undefined) {
				localStorage.setItem("aq_adcChars", adcCharacteristics.toJSON());
			}
			SessionManager.saveSegmentCount(segmentRef.current);
			const samplingRate = device.getSamplingRate?.();
			if (samplingRate) {
				SessionManager.saveSampleRate(samplingRate);
			}
			const currentChannels = device.getChannels?.() ?? [];
			if (currentChannels.length > 0) {
				SessionManager.saveChannels(currentChannels);
			}
		}
	}, []);

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
					let samplingRate = Number(settings.samplingRate)
					if (!Number.isFinite(samplingRate) || samplingRate <= 0) {
						samplingRate = 1000;
					}

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

			// Only set buffer size if valid
			if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current)
			}
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
		console.log("\n[start] Starting acquisition\n");
		const device = deviceRef.current
		if (!device) return

		try {
			// Clear session/segment buffers only at the start of a new acquisition
			fullSessionFramesRef.current = [];
			allSegmentsRef.current = [];

			// cleanupPipeline is already called inside initializePipeline
			const sampleRate = device.getSamplingRate?.() || 1000;
			initializePipeline(sampleRate);


			   // Start acquisition and get sessionFolder from Electron
			   const startTime = new Date().toISOString();
			   const sessionFolder = await window.electronAPI?.startAcquisition?.(startTime);

			   // Get adcChars if available
			   const adcChars = device.getAdcCharacteristics?.() || {};

			// Create session manifest at start with all metadata via SessionManager only
			const now = Date.now();
			SessionManager.createSession({
				sessionId: `${now}`,
				startedAt: now,
				deviceType: device instanceof Maker ? "maker" : "sense",
				sampleRate,
				channels: device.getChannels?.() ?? [],
				sessionFolder,
				adcChars
			});
			SessionManager.registerSegment({
				index: segmentRef.current,
				startedAt: now,
				endedAt: null
			});

			   bufferManagerRef.current?.startSession({
				   startedAt: Date.now(),
				   sampleRate,
				   segment: segmentRef.current
			   });

			   // Only set buffer size if valid
			   if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				   window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current);
			   }

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
	}, [initializePipeline, persistSessionMetadata])

	const pause = useCallback(async () => {
		console.log("\n[pause] Pausing acquisition\n");
		if (!deviceRef.current) return

		deviceRef.current.onError = () => {
			// ignore during controlled pause
		}

		try {
			await deviceRef.current.stopAcquisition?.()
			bufferManagerRef.current?.flushChunk?.(false)

			// Update last segment's endedAt in manifest using API
			const endedAt = Date.now();
			SessionManager.updateSegmentEndedAt(segmentRef.current, endedAt);

			// Only for validation/testing
			if ((typeof process !== 'undefined' && process.env.TESTING_STORAGE === '1') || (typeof window !== 'undefined' && window.TESTING_STORAGE === '1')) {
				saveCurrentSegment();
			}

			if (fullSessionFramesRef.current.length > 0) {
				allSegmentsRef.current.push([...fullSessionFramesRef.current])
			}

			fullSessionFramesRef.current = []
			setStatus(STATUS.PAUSED)
		} catch (error) {
			console.error(error)
			setStatus(STATUS.CONNECTION_LOST)
		}
	}, [saveCurrentSegment])

	const resume = useCallback(async () => {
		console.log("\n[resume] Resuming acquisition\n");
		// Reset full session buffer for new segment (already saved at pause)
		fullSessionFramesRef.current = [];
		if (!deviceRef.current) return;

		deviceRef.current.onError = error => {
			console.error(error);
			deviceRef.current?.disconnect?.().finally(() => {
				deviceRef.current = null;
				setStatus(STATUS.CONNECTION_LOST);
			});
		};

		try {
			segmentRef.current += 1

			frameSequenceRef.current = 0
			graphBufferRef.current = []
			channelsRef.current = []

			setGraphBuffer([])
			setChannels([])
			setXDomain([0, 0])
			setAcquisitionStarted(false)
			acquisitionStartedRef.current = false;

			bufferManagerRef.current?.reset()
			const now = Date.now();
			bufferManagerRef.current?.startSession({
				startedAt: now,
				sampleRate: deviceRef.current.getSamplingRate?.() || 1000,
				segment: segmentRef.current
			})

			// Explicitly await and document sessionFolder for consistency
			// In resume, sessionFolder is not used, but we await for consistency and clarity
			const resumedSessionFolder = await window.electronAPI?.startAcquisition?.(new Date().toISOString());
			SessionManager.saveSegmentCount(segmentRef.current)

			// Register new segment in manifest
			SessionManager.registerSegment({
				index: segmentRef.current,
				startedAt: now,
				endedAt: null
			});

			await deviceRef.current.startAcquisition?.()
			setStatus(STATUS.ACQUIRING)
		} catch (error) {
			console.error(error)
			setStatus(STATUS.CONNECTION_LOST)
		}
	}, [])


	const stop = useCallback(async () => {
		console.log("\n[stop] Stopping acquisition\n");
		if (!deviceRef.current) return;

		deviceRef.current.onError = () => {
			// We are already stopping and disconnecting the device
		};

		setStatus(STATUS.STOPPING);

		
		try {
			await deviceRef.current?.stopAcquisition();
			await deviceRef.current?.disconnect();
			deviceRef.current = null;
		} catch {
			// ignore
		}

		// Update last segment's endedAt in manifest using API
		const endedAt = Date.now();
		SessionManager.updateSegmentEndedAt(segmentRef.current, endedAt);

		setStatus(STATUS.STOPPED);
	}, []);


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
						const { channelName } = values;
						// Persist channel names in manifest
						SessionManager.setChannelNames(channelName);
						// For validation/testing: only write to localStorage if TESTING_STORAGE=1
						if ((typeof process !== 'undefined' && process.env.TESTING_STORAGE === '1') || (typeof window !== 'undefined' && window.TESTING_STORAGE === '1')) {
							localStorage.setItem(
								"aq_channelNames",
								JSON.stringify(channelName)
							);
						}
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