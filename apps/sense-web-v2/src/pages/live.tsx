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
import {
	SessionSettings,
	saveLastSessionSettingsPersistent
} from "../utils/sessionSettingsHistory"

import { framePublisher } from "../../../sense-desktop/src/FramePublisher"


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
const backgroundDarkColor =
	(fullConfig.theme as any)?.colors?.["background-dark"] ?? "#1C1C1E"
const outlineColorLight =
	fullConfig.theme.colors["over-background-highest-light"]
const outlineColorDark =
	fullConfig.theme.colors["over-background-highest-dark"]

const UI_WINDOW_SECONDS = 5
const UI_BUCKETS = 300
const UI_TICK_MS = 66

type ChannelPoint = [number, number | null]
type ChannelSeries = Record<string, ChannelPoint[]>

interface MinMaxBucketState {
	count: number
	min: number
	max: number
	minSeq: number
	maxSeq: number
}

class RingBuffer<T> {
	private buf: T[]
	private head = 0
	private count = 0
	private version = 0
	private snapshotVersion = -1
	private snapshot: T[] = []

	constructor(private capacity: number) {
		this.buf = new Array<T>(capacity)
	}

	push(item: T) {
		this.buf[this.head] = item
		this.head = (this.head + 1) % this.capacity
		if (this.count < this.capacity) this.count++
		this.version++
	}

	toArray(): T[] {
		if (this.snapshotVersion === this.version) {
			return this.snapshot
		}

		if (this.count < this.capacity) {
			this.snapshot = this.buf.slice(0, this.count)
		} else {
			this.snapshot = [
				...this.buf.slice(this.head),
				...this.buf.slice(0, this.head)
			]
		}

		this.snapshotVersion = this.version
		return this.snapshot
	}

	clear() {
		this.head = 0
		this.count = 0
		this.version++
		this.snapshotVersion = -1
		this.snapshot = []
	}
}

const flushBucketToRing = (
	state: MinMaxBucketState,
	ring: RingBuffer<ChannelPoint>
) => {
	if (state.count === 0) return

	if (state.minSeq === state.maxSeq) {
		ring.push([state.minSeq, state.min])
	} else if (state.minSeq < state.maxSeq) {
		ring.push([state.minSeq, state.min])
		ring.push([state.maxSeq, state.max])
	} else {
		ring.push([state.maxSeq, state.max])
		ring.push([state.minSeq, state.min])
	}

	state.count = 0
}

const flushAllBuckets = (
	buckets: Map<string, MinMaxBucketState>,
	buffers: Map<string, RingBuffer<ChannelPoint>>,
	channels: string[]
) => {
	for (const channel of channels) {
		const bucket = buckets.get(channel)
		const ring = buffers.get(channel)
		if (!bucket || !ring) continue
		flushBucketToRing(bucket, ring)
	}
}

const channelSeriesEqual = (a: ChannelSeries, b: ChannelSeries) => {
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)
	if (aKeys.length !== bKeys.length) return false
	for (const key of aKeys) {
		if (a[key] !== b[key]) return false
	}
	return true
}

const Page = () => {
	const storeBufferThresholdRef = useRef(10000);
	// Track last chunk flush time and threshold for dynamic adjustment

	const router = useRouter();
	const isDark = useDarkTheme();

	const deviceRef = useRef<Device | null>(null);
	// BufferManager is now in main process

	const subscriptionsRef = useRef<Array<() => void>>([]);
	const segmentRef = useRef(1);
	const finalizingAfterErrorRef = useRef(false)

	const [status, setStatus] = useState(STATUS.DISCONNECTED);

	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null);
	const [acquisitionStarted, setAcquisitionStarted] = useState(false);
	const acquisitionStartedRef = useRef(false);

	const channelBuffersRef = useRef<Map<string, RingBuffer<ChannelPoint>>>(new Map());
	const channelBucketsRef = useRef<Map<string, MinMaxBucketState>>(new Map());
	const [channelData, setChannelData] = useState<ChannelSeries>({});
	const channelsRef = useRef<string[]>([]);
	const [channels, setChannels] = useState<string[]>([]);
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0]);
	const frameSequenceRef = useRef(0);
	const uiWindowFramesRef = useRef(0);
	const xAxisOffsetFramesRef = useRef(0);

	// Use setInterval to update the graph UI even when window is not focused
    useEffect(() => {
        let intervalId: NodeJS.Timeout | null = null;
        function updateUI() {
			// While acquiring, only finalized buckets should be emitted (ingest path).
			// Flushing partial buckets every UI tick over-emits points and shrinks
			// the effective visible time span due to ring buffer eviction.
			if (status === STATUS.PAUSED) {
				flushAllBuckets(
					channelBucketsRef.current,
					channelBuffersRef.current,
					channelsRef.current
				)
			}

			const windowFrames = uiWindowFramesRef.current
			const windowStart = Math.max(0, frameSequenceRef.current - windowFrames)
			xAxisOffsetFramesRef.current = windowStart

			const nextData: ChannelSeries = {};
			for (const channel of channelsRef.current) {
				const channelSeries =
					channelBuffersRef.current.get(channel)?.toArray() ?? []
				nextData[channel] = channelSeries.map(point => [
					point[0] - windowStart,
					point[1]
				])
			}

			setChannelData(prev =>
				channelSeriesEqual(prev, nextData) ? prev : nextData
			)

				const nextDomain: [number, number] = [
				0,
				windowFrames
			]
			setXDomain(prev =>
				prev[0] === nextDomain[0] && prev[1] === nextDomain[1]
					? prev
					: nextDomain
			)
        }
		if (status === STATUS.ACQUIRING || status === STATUS.PAUSED) {
			intervalId = setInterval(updateUI, UI_TICK_MS);
        }
        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [status]);

	useEffect(() => {
		if (!window.electronAPI?.onChunkWriteComplete) return;
		const unsubscribe = window.electronAPI.onChunkWriteComplete((_info) => {
			// Manifest update now handled in main process
		});
		return unsubscribe;
	}, []);


	useEffect(() => {
		const finalizeStop = async () => {
			if (status !== STATUS.STOPPED) return;
			const stopTime = Date.now();
			try {
				window.electronAPI?.flushChunk?.(true);
				await new Promise<void>(resolve => {
					let resolved = false;
					const timeout = setTimeout(() => {
						if (!resolved) {
							resolved = true;
							unsubscribe?.();
							resolve();
						}
					}, 200);
					const unsubscribe = window.electronAPI?.onChunkWriteComplete?.(info => {
						if (info?.final && !resolved) {
							resolved = true;
							clearTimeout(timeout);
							unsubscribe?.();
							resolve();
						}
					});
				});
				window.electronAPI?.logPerfEvent?.('acquisition_end', Date.now() - stopTime);
				await window.electronAPI?.finalizeSession?.(Date.now());
				setStatus(STATUS.STOPPED_AND_SAVED);
				await router.push("/summary");
			} catch (error) {
				console.error("[finalizeStop]", error);
				setStatus(STATUS.STOPPED_AND_SAVED);
			}
		};
		finalizeStop();
	}, [status, router]);
	
	const cleanupPipeline = useCallback(() => {
		subscriptionsRef.current.forEach(unsubscribe => {
			try {
				unsubscribe?.();
			} catch {}
		});
		subscriptionsRef.current = [];

		frameSequenceRef.current = 0;
		channelBuffersRef.current.forEach(buffer => buffer.clear())
		channelBuffersRef.current.clear()
		channelBucketsRef.current.clear()
		channelsRef.current = [];
		uiWindowFramesRef.current = 0
		xAxisOffsetFramesRef.current = 0

		setChannelData({});
		setChannels([]);
		setXDomain([0, 0]);
		setAcquisitionStarted(false);
		acquisitionStartedRef.current = false;
	}, []);




	// No BufferManager/StorageSubscriber in renderer; only UI pipeline
	const initializePipeline = useCallback(
		(sampleRate: number) => {
			cleanupPipeline();

			const uiWindowFrames = Math.ceil(sampleRate * UI_WINDOW_SECONDS)
			const bucketSize = Math.max(
				1,
				Math.ceil(uiWindowFrames / Math.max(1, UI_BUCKETS))
			)
			uiWindowFramesRef.current = uiWindowFrames

			const unsubscribeUIPublisher = framePublisher.subscribeFrame(frame => {
				if (!frame) return;

				const seq = frameSequenceRef.current++
				const channelValues = frame.channels as
					| Record<string, number>
					| undefined
				if (!channelValues) return

				if (channelsRef.current.length === 0 && frame.channels) {
					channelsRef.current = Object.keys(frame.channels).sort();
					channelsRef.current.forEach(channel => {
						channelBuffersRef.current.set(
							channel,
							new RingBuffer<ChannelPoint>(UI_BUCKETS * 2)
						)
						channelBucketsRef.current.set(channel, {
							count: 0,
							min: 0,
							max: 0,
							minSeq: 0,
							maxSeq: 0
						})
					})
					setChannels([...channelsRef.current]);
				}

				for (const channel of channelsRef.current) {
					const valueRaw = channelValues[channel]
					if (valueRaw == null) continue
					const value = Number(valueRaw)
					if (!Number.isFinite(value)) continue

					let bucket = channelBucketsRef.current.get(channel)
					const ring = channelBuffersRef.current.get(channel)
					if (!ring) continue
					if (!bucket) continue

					if (bucket.count === 0) {
						bucket.min = value
						bucket.max = value
						bucket.minSeq = seq
						bucket.maxSeq = seq
					} else {
						if (value < bucket.min) {
							bucket.min = value
							bucket.minSeq = seq
						}
						if (value > bucket.max) {
							bucket.max = value
							bucket.maxSeq = seq
						}
					}

					bucket.count += 1
					if (bucket.count >= bucketSize) {
						flushBucketToRing(bucket, ring)
					}
				}

				if (!acquisitionStartedRef.current) {
					acquisitionStartedRef.current = true;
					setAcquisitionStarted(true);
				}
			});

			subscriptionsRef.current = [
				unsubscribeUIPublisher
			];
		},
		[cleanupPipeline]
	);

	const persistSessionMetadata = useCallback(() => {
		const device = deviceRef.current;
		if (!device) return;
		const settings = JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, unknown>
		const configuredSignalKinds =
			typeof settings.channelSignalKinds === "object" && settings.channelSignalKinds !== null
				? (settings.channelSignalKinds as Record<string, string>)
				: {}
		const deviceChannels = (device.getChannels?.() ?? []).map(String)
		const channelSignalKinds = Object.fromEntries(
			Object.entries(configuredSignalKinds).filter(
				([channel, signalKind]) =>
					deviceChannels.includes(channel) &&
					typeof signalKind === "string" &&
					signalKind.length > 0
			)
		)
		window.electronAPI?.updateSessionMeta?.({
			segment: segmentRef.current,
			channels: deviceChannels,
			sampleRate: device.getSamplingRate?.() || 1000,
			deviceType: device instanceof Maker ? "maker" : "sense",
			channelSignalKinds,
			timestamp: Date.now()
		});
	}, []);

	const connect = useCallback(async () => {
		setStatus(STATUS.CONNECTING)
		setAcquisitionStarted(false)
		cleanupPipeline(); // Reset all state and BufferManager before connect

		 const settings = JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, unknown>;

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

			const connectStart = Date.now();
			await deviceRef.current.connect()
			
			// Only save to history if valid configuration
			const isValidConfig = 
				(settings.deviceType === "sense" && Array.isArray(settings.channels) && settings.channels.length > 0) ||
				(settings.deviceType === "maker")
			if (isValidConfig) {
				await saveLastSessionSettingsPersistent(settings as SessionSettings)
			}
			
			window.electronAPI?.logPerfEvent?.('device_connect', Date.now() - connectStart);

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
			deviceRef.current = null

			if (error instanceof CancelledByUserException) {
				setStatus(STATUS.DISCONNECTED)
				return
			}
			setStatus(STATUS.CONNECTION_FAILED)
		}
	}, [cleanupPipeline])

	const disconnect = useCallback(async () => {
		try {
			deviceRef.current!.onError = () => {
				// ignore controlled disconnect errors
			};

			await deviceRef.current?.disconnect?.();
		} catch {
			// ignore disconnect errors
		} finally {
			framePublisher.reset();
			cleanupPipeline();
			deviceRef.current = null;
			setStatus(STATUS.DISCONNECTED);
		}
	}, [cleanupPipeline]);

	const handleUnexpectedAcquisitionStop = useCallback(() => {
		if (finalizingAfterErrorRef.current) return
		finalizingAfterErrorRef.current = true
		window.electronAPI?.logPerfEvent?.('connection_lost')

		const finalizeAfterError = async () => {
			try {
				await deviceRef.current?.stopAcquisition?.()
			} catch {
				// ignore controlled stop errors after connection loss
			}

			try {
				await deviceRef.current?.disconnect?.()
			} catch {
				// ignore disconnect errors after connection loss
			}

			deviceRef.current = null
			window.electronAPI?.updateSegmentEndedAt?.(segmentRef.current, Date.now())
			setStatus(STATUS.STOPPED)
		}

		void finalizeAfterError()
	}, [])

	const start = useCallback(async () => {
		console.log("\n[start] Starting acquisition\n");
		const device = deviceRef.current;
		if (!device) return;
		finalizingAfterErrorRef.current = false
		const settings = JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, unknown>

		const startAcqTime = Date.now();
		try {
			const sampleRate = device.getSamplingRate?.() || 1000;
			initializePipeline(sampleRate);

			const startTime = new Date().toISOString();
			const sessionFolder = await window.electronAPI?.startAcquisition?.(startTime);

			const adcChars = device.getAdcCharacteristics?.() || {};

			const now = Date.now();
			const configuredSignalKinds =
				typeof settings.channelSignalKinds === "object" && settings.channelSignalKinds !== null
					? (settings.channelSignalKinds as Record<string, string>)
					: {}
			const sessionChannels = (device.getChannels?.() ?? []).map(String)
			const channelSignalKinds = Object.fromEntries(
				Object.entries(configuredSignalKinds).filter(
					([channel, signalKind]) =>
						sessionChannels.includes(channel) &&
						typeof signalKind === "string" &&
						signalKind.length > 0
				)
			)
			await window.electronAPI?.createSession?.({
				sessionId: `${now}`,
				startedAt: now,
				deviceType: device instanceof Maker ? "maker" : "sense",
				sampleRate,
				channels: sessionChannels,
				channelSignalKinds,
				sessionFolder,
				adcChars
			});
			await window.electronAPI?.registerSegment?.({
				index: segmentRef.current,
				startedAt: now,
				endedAt: null
			});

			// Only set buffer size if valid
			if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current);
			}

			persistSessionMetadata();

			device.onFrames = data => {
				if (data == null) return;
				// Always pass every frame to main process BufferManager via sendFrame
				if (Array.isArray(data)) {
					const validFrames = data.filter(Boolean);
					validFrames.forEach(frame => {
						window.electronAPI?.sendFrame?.(frame);
						// Publish to framePublisher for UI graph
						framePublisher.publishFrame(frame);
					});
				} else {
					window.electronAPI?.sendFrame?.(data);
					framePublisher.publishFrame(data);
				}
			};

			device.onError = error => {
				console.error(error);
				// No BufferManager in renderer; main process handles chunking
				if (window.electronAPI?.acquisitionError && sessionFolder) {
					window.electronAPI.acquisitionError(sessionFolder);
				}
				console.log("\n[device.onError] Device error, disconnecting and updating status\n");
				handleUnexpectedAcquisitionStop()
			};

			await device.startAcquisition?.();
			window.electronAPI?.logPerfEvent?.('acquisition_start', Date.now() - startAcqTime);
			setStatus(STATUS.ACQUIRING);
		} catch (error) {
			console.error(error);
			console.log("\n[start] Connection failed, updating status\n");
			setStatus(STATUS.CONNECTION_LOST);
		}
	}, [initializePipeline, persistSessionMetadata, handleUnexpectedAcquisitionStop])

	const pause = useCallback(async () => {
		console.log("\n[pause] Pausing acquisition\n");
		const pauseTime = Date.now();
		if (!deviceRef.current) return;

		deviceRef.current.onError = () => {
			// ignore during controlled pause
		};

		try {
			await deviceRef.current.stopAcquisition?.();
			window.electronAPI?.flushChunk?.(false);

			const endedAt = Date.now();
			window.electronAPI?.updateSegmentEndedAt?.(segmentRef.current, endedAt);
			window.electronAPI?.logPerfEvent?.('acquisition_pause', Date.now() - pauseTime);
			setStatus(STATUS.PAUSED);
		} catch (error) {
			console.error(error);
			console.log("\n[pause] Error during pause, updating status\n");
			handleUnexpectedAcquisitionStop()
		}
	}, [handleUnexpectedAcquisitionStop]);

	const resume = useCallback(async () => {
		console.log("\n[resume] Resuming acquisition\n");
		const resumeTime = Date.now();
		if (!deviceRef.current) return;

		deviceRef.current.onError = error => {
			console.error(error);
			console.log("\n[device.onError] Device error during resume, disconnecting and updating status\n");
			handleUnexpectedAcquisitionStop()
		};

		try {
			segmentRef.current += 1;
			const sampleRate = deviceRef.current.getSamplingRate?.() || 1000
			initializePipeline(sampleRate)

			await window.electronAPI?.startAcquisition?.(new Date().toISOString());

			const now = Date.now();
			await window.electronAPI?.registerSegment?.({
				index: segmentRef.current,
				startedAt: now,
				endedAt: null
			});

			await deviceRef.current.startAcquisition?.();
			window.electronAPI?.logPerfEvent?.('acquisition_resume', Date.now() - resumeTime);
			setStatus(STATUS.ACQUIRING);
		} catch (error) {
			console.error(error);
			console.log("\n[resume] Error during resume, updating status\n");
			handleUnexpectedAcquisitionStop()
		}
	}, [initializePipeline, handleUnexpectedAcquisitionStop]);

	const stop = useCallback(async () => {
		console.log("\n[stop] Stopping acquisition\n");
		if (!deviceRef.current) return;

		deviceRef.current.onError = () => {
			// We are already stopping and disconnecting the device
		};

		setStatus(STATUS.STOPPING);
    
		try {
			await deviceRef.current.stopAcquisition?.();
			await deviceRef.current.disconnect?.();
		} catch {
			// ignore controlled stop errors
		} finally {
			deviceRef.current = null;
		}

		const endedAt = Date.now();
		window.electronAPI?.updateSegmentEndedAt?.(segmentRef.current, endedAt);

		finalizingAfterErrorRef.current = false
		setStatus(STATUS.STOPPED);
	}, []);

	useEffect(() => {
		return () => {
			cleanupPipeline();
			deviceRef.current?.disconnect?.().catch(() => {});
			// Reset main-process session state when navigating away.
			// If finalizeSession was already called (normal stop flow), this is a no-op.
			// If the user left without stopping, this ensures the next acquisition
			// gets a fresh session folder instead of continuing the abandoned one.
			window.electronAPI?.resetSession?.();
		};
	}, [cleanupPipeline])

	const xTickFormatter = useCallback((value: number) => {
		const samplingRate = deviceRef.current?.getSamplingRate?.() || 1
		const absoluteValue = value + xAxisOffsetFramesRef.current
		const time = samplingRate !== 0 ? absoluteValue / samplingRate : absoluteValue

		if (time < 0) return "0:00"

		const seconds = Math.floor(time % 60)
		const minutes = Math.floor(time / 60)

		return seconds < 10 ? `${minutes}:0${seconds}` : `${minutes}:${seconds}`
	}, [])

	const [showCloseModal, setShowCloseModal] = useState(false);

	// Ref so event handlers always see the latest status without stale closures
	const statusRef = useRef(status);
	useEffect(() => { statusRef.current = status; }, [status]);

	// Electron X button: warn if acquiring, else allow close
	useEffect(() => {
		if (!window.electronAPI?.onShowCloseWarning) return;
		const removeCloseListener = window.electronAPI.onShowCloseWarning(() => {
			if (statusRef.current === STATUS.ACQUIRING || statusRef.current === STATUS.PAUSED) {
				setShowCloseModal(true);
			} else {
				window.electronAPI?.confirmClose?.(true);
			}
		});
		return removeCloseListener;
	}, []); // set up once — statusRef always has the latest value

	// In-app navigation (home button): block if acquiring or paused
	useEffect(() => {
		const handleRouteChange = (url: string) => {
			if (statusRef.current === STATUS.ACQUIRING || statusRef.current === STATUS.PAUSED) {
				setShowCloseModal(true);
				router.events.emit('routeChangeError', 'aborted', url);
				throw 'Navigation blocked during acquisition.';
			}
		};
		router.events.on('routeChangeStart', handleRouteChange);
		return () => { router.events.off('routeChangeStart', handleRouteChange); };
	}, [router.events]);

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
			<div className="flex flex-row gap-4">				{(status === STATUS.DISCONNECTED ||
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
			{status === STATUS.ACQUIRING && channels.length > 0 && (
				<Formik
					enableReinitialize
					initialValues={{
						channelName: channels.reduce(
							(acc, channel) => {
							acc[channel] = channel || "";
							return acc;
						},
						{} as Record<string, string>
					)
					}}
					onSubmit={async values => {
						const { channelName } = values;
						window.electronAPI?.setChannelNames?.(channelName);
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
												data={channelData[channel] ?? []}
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
			{showCloseModal && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
					<div
						className="rounded-lg shadow-lg p-8 max-w-md w-full text-white"
						style={{ backgroundColor: `${backgroundDarkColor}E6` }}
					>
						<h2 className="text-xl font-bold mb-4 text-red-600">Ongoing Acquisition</h2>
						<p className="mb-4">
							An acquisition is currently running. If you want to close the tab, please stop the acquisition first.
						</p>
						<div className="flex justify-end gap-4">
							<TextButton
								size={"base"}
								onClick={() => {
									setShowCloseModal(false);
									window.electronAPI?.confirmClose?.(false);
								}}
							>
								Ok
							</TextButton>
						</div>
					</div>
				</div>
			)}
		</SenseLayout>
	)
}

export default Page