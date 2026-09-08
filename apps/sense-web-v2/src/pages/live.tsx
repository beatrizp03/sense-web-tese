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
import clsx from "clsx"
import {
	CancelledByUserException,
	ConnectionLostException,
	Device,
	Maker,
	SCIENTISST_CHANNEL,
	SCIENTISST_COMUNICATION_MODE,
	ScientISST,
	TooManyFramesLostException
} from "@scientisst/sense/future"
import { Form, Formik } from "formik"
import resolveConfig from "tailwindcss/resolveConfig"

import tailwindConfig from "../../tailwind.config"
import CanvasChart from "../components/charts/CanvasChart"
import SenseLayout from "../components/layout/SenseLayout"
import { useBusyGuard } from "../hooks/useBusyGuard"
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

const LIVE_SIGNAL_TYPE_OPTIONS = [
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

const LIVE_ACC_AXIS_OPTIONS = [
	{ label: "--", value: "" },
	{ label: "X", value: "x" },
	{ label: "Y", value: "y" },
	{ label: "Z", value: "z" }
]
const IO_INPUTS = ["I1", "I2"]
const IO_OUTPUTS = ["O1", "O2"]
const IO_PORT_CHANNELS = [...IO_INPUTS, ...IO_OUTPUTS]

const isIoPort = (channel: string) => IO_PORT_CHANNELS.includes(channel)

function getOrderedEegChannels(
	channelSignalKinds: Record<string, string>,
	channels: string[]
) {
	return channels.filter(channel => channelSignalKinds[channel] === "eeg")
}

/** One channel as it will be recorded: port, custom name and configured signal type. */
interface SetupReviewChannel {
	channel: string
	name: string
	kind: string
	axis: string
}

/** Snapshot of the settings the device was actually connected with. */
interface SetupReview {
	deviceType: string
	connection: string
	samplingRate: number | null
	channels: SetupReviewChannel[]
}

function signalKindLabel(kind: string): string {
	return LIVE_SIGNAL_TYPE_OPTIONS.find(option => option.value === kind && option.value !== "")?.label ?? ""
}

function isExpectedDeviceLoss(error: unknown): boolean {
	return (
		error instanceof TooManyFramesLostException ||
		error instanceof ConnectionLostException ||
		(error instanceof Error && error.message.includes("Serial read timed out"))
	)
}

function writeLiveSettingsPatch(updates: Record<string, unknown>) {
	try {
		const current = JSON.parse(localStorage.getItem("settings") || "{}")
		localStorage.setItem("settings", JSON.stringify({ ...current, ...updates }))
	} catch {
		// ignore corrupted/locked settings storage
	}
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

const DISCONNECT_NOTICE_MS = 3000

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

	const router = useRouter();
	const isDark = useDarkTheme();

	const deviceRef = useRef<Device | null>(null);

	const subscriptionsRef = useRef<Array<() => void>>([]);
	const segmentRef = useRef(1);
	const finalizingAfterErrorRef = useRef(false)

	const [status, setStatus] = useState(STATUS.DISCONNECTED);
	const [connectWarning, setConnectWarning] = useState<string | null>(null);
	
	useBusyGuard(
		status === STATUS.ACQUIRING || status === STATUS.PAUSED ? "Recording" : null
	);
	const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null);
	const [acquisitionStarted, setAcquisitionStarted] = useState(false);
	const acquisitionStartedRef = useRef(false);
	const [connectedDeviceLabel, setConnectedDeviceLabel] = useState<string>("Unknown");
	const [setupReview, setSetupReview] = useState<SetupReview | null>(null);
	const [disconnectNotice, setDisconnectNotice] = useState(false);
	const disconnectedAtRef = useRef(0);


	const channelBuffersRef = useRef<Map<string, RingBuffer<ChannelPoint>>>(new Map());
	const channelBucketsRef = useRef<Map<string, MinMaxBucketState>>(new Map());
	const bucketListRef = useRef<MinMaxBucketState[]>([]);
	const ringListRef = useRef<RingBuffer<ChannelPoint>[]>([]);
	const [channelData, setChannelData] = useState<ChannelSeries>({});
	const channelsRef = useRef<string[]>([]);
	const [channels, setChannels] = useState<string[]>([]);
	const [liveSignalKinds, setLiveSignalKinds] = useState<Record<string, string>>({});
	const [liveSignalAxes, setLiveSignalAxes] = useState<Record<string, string>>({});
	const [liveChannelNames, setLiveChannelNames] = useState<Record<string, string>>({});
	const channelLastSeqRef = useRef<Map<string, number>>(new Map());
	const [activeChannels, setActiveChannels] = useState<Record<string, boolean>>({});
	const [xDomain, setXDomain] = useState<[number, number]>([0, 0]);
	const frameSequenceRef = useRef(0);
	const uiWindowFramesRef = useRef(0);
	const xAxisOffsetFramesRef = useRef(0);

    useEffect(() => {
        let intervalId: NodeJS.Timeout | null = null;
        function updateUI() {
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
				if (finalizingAfterErrorRef.current) {
					const shown = Date.now() - disconnectedAtRef.current;
					if (shown < DISCONNECT_NOTICE_MS) {
						await new Promise<void>(resolve =>
							setTimeout(resolve, DISCONNECT_NOTICE_MS - shown)
						);
					}
				}
				await router.push(
					finalizingAfterErrorRef.current
						? "/summary?interrupted=1"
						: "/summary"
				);
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
		bucketListRef.current = []
		ringListRef.current = []
		channelsRef.current = [];
		uiWindowFramesRef.current = 0
		xAxisOffsetFramesRef.current = 0

		setChannelData({});
		setChannels([]);
		setXDomain([0, 0]);
		setAcquisitionStarted(false);
		acquisitionStartedRef.current = false;
	}, []);

	const initializePipeline = useCallback(
		(sampleRate: number) => {
			cleanupPipeline();

			const uiWindowFrames = Math.ceil(sampleRate * UI_WINDOW_SECONDS)
			const bucketSize = Math.max(
				1,
				Math.ceil(uiWindowFrames / Math.max(1, UI_BUCKETS))
			)
			uiWindowFramesRef.current = uiWindowFrames

			const ingestFrameForChart = (frame: any) => {
				if (!frame) return;

				const seq = frameSequenceRef.current++
				const channelValues = frame.channels as
					| Record<string, number>
					| undefined
				if (!channelValues) return

				for (const port of IO_PORT_CHANNELS) {
					const raw = channelValues[port]
					if (raw == null) continue
					const on = Number(raw) !== 0
					setActiveChannels(prev =>
						prev[port] === on ? prev : { ...prev, [port]: on }
					)
				}

				if (channelsRef.current.length === 0 && frame.channels) {
					channelsRef.current = Object.keys(frame.channels)
						.filter(channel => !isIoPort(channel))
						.sort();
					bucketListRef.current = []
					ringListRef.current = []
					channelsRef.current.forEach(channel => {
						const ring = new RingBuffer<ChannelPoint>(UI_BUCKETS * 2)
						const bucket: MinMaxBucketState = {
							count: 0,
							min: 0,
							max: 0,
							minSeq: 0,
							maxSeq: 0
						}
						channelBuffersRef.current.set(channel, ring)
						channelBucketsRef.current.set(channel, bucket)
						ringListRef.current.push(ring)
						bucketListRef.current.push(bucket)
					})
					setChannels([...channelsRef.current]);
				}

				const channelNames = channelsRef.current
				const buckets = bucketListRef.current
				const rings = ringListRef.current

				for (let c = 0; c < channelNames.length; c++) {
					const valueRaw = channelValues[channelNames[c]]
					if (valueRaw == null) continue
					const value = Number(valueRaw)
					if (!Number.isFinite(value)) continue

					const bucket = buckets[c]
					const ring = rings[c]
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
			};

			const unsubscribeUIPublisher = framePublisher.subscribeFrames(frames => {
				for (let i = 0; i < frames.length; i++) {
					ingestFrameForChart(frames[i])
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
		const configuredSignalAxes =
			typeof settings.channelSignalAxes === "object" && settings.channelSignalAxes !== null
				? (settings.channelSignalAxes as Record<string, string>)
				: {}
		const deviceChannels = (device.getChannels?.() ?? []).map(String).filter(channel => !isIoPort(channel))
		const channelSignalKinds = Object.fromEntries(
			Object.entries(configuredSignalKinds).filter(
				([channel, signalKind]) =>
					deviceChannels.includes(channel) &&
					typeof signalKind === "string" &&
					signalKind.length > 0
			)
		)
		const channelSignalAxes = Object.fromEntries(
			Object.entries(configuredSignalAxes).filter(
				([channel, signalAxis]) =>
					deviceChannels.includes(channel) &&
					channelSignalKinds[channel] === "acc" &&
					typeof signalAxis === "string" &&
					["x", "y", "z"].includes(signalAxis)
			)
		)
		const eegChannels = getOrderedEegChannels(channelSignalKinds, deviceChannels)
		window.electronAPI?.updateSessionMeta?.({
			segment: segmentRef.current,
			channels: deviceChannels,
			sampleRate: device.getSamplingRate?.() || 1000,
			deviceType: device instanceof Maker ? "maker" : "sense",
			...(eegChannels.length > 0 ? { eegChannels } : {}),
			channelSignalKinds,
			channelSignalAxes,
			timestamp: Date.now()
		});
	}, []);

	const connect = useCallback(async () => {
		setConnectWarning(null)
		setStatus(STATUS.CONNECTING)
		setAcquisitionStarted(false)
		setSetupReview(null)
		setDisconnectNotice(false)
		cleanupPipeline();

		const settings = JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, unknown>

		try {
			let selectedPort
			let deviceLabel
			if (window.electronAPI?.listSerialPorts) {
				let ports: any[] = []

				try {
					ports = (await window.electronAPI.listSerialPorts()) ?? []
				} catch {
					ports = []
				}
				if (ports.length === 0) {
					setConnectWarning(
						"No device found. Check that Bluetooth is turned on and your ScientISST board is paired, then try again."
					)
					setStatus(STATUS.DISCONNECTED)
					return
				}
				const hasBluetooth = ports.some(port => /bluetooth/i.test(String(port?.friendlyName ?? "")))
				if (!hasBluetooth) {
					setConnectWarning(
						"No Bluetooth device detected. If your board connects over Bluetooth, turn it on and pair it, otherwise pick your wired port below."
					)
				}

				const selectedPortPath = String((settings as any).port ?? "")
				selectedPort =
					ports.find(port => String(port?.path ?? "") === selectedPortPath) ??
					ports.find(port => /bluetooth/i.test(String(port?.friendlyName ?? ""))) ??
					null

				deviceLabel = String(
					selectedPort?.friendlyName ??
					selectedPort?.path ??
					"Unknown"
				)
			}

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
					const configuredChannels = (settings.channels ?? [
						"AI1",
						"AI2",
						"AI3",
						"AI4",
						"AI5",
						"AI6"
					]) as SCIENTISST_CHANNEL[]
					const selectedChannels = [
						...configuredChannels.filter(channel => !isIoPort(channel)),
						...(IO_PORT_CHANNELS as SCIENTISST_CHANNEL[])
					]
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
			
			const isValidConfig = 
				(settings.deviceType === "sense" && Array.isArray(settings.channels) && settings.channels.length > 0) ||
				(settings.deviceType === "maker")
			if (isValidConfig) {
				await saveLastSessionSettingsPersistent(settings as SessionSettings)
			}
			
			window.electronAPI?.logPerfEvent?.('device_connect', Date.now() - connectStart);

			segmentRef.current = 1
			setConnectedDeviceLabel(deviceLabel ?? "Unknown")
			setFirmwareVersion(deviceRef.current.getFirmwareVersion()?.version ?? null)

			const deviceType = String(settings.deviceType ?? "sense")
			const reviewKinds =
				typeof settings.channelSignalKinds === "object" && settings.channelSignalKinds !== null
					? (settings.channelSignalKinds as Record<string, string>)
					: {}
			const reviewAxes =
				typeof settings.channelSignalAxes === "object" && settings.channelSignalAxes !== null
					? (settings.channelSignalAxes as Record<string, string>)
					: {}
			const reviewNames =
				typeof settings.channelNames === "object" && settings.channelNames !== null
					? (settings.channelNames as Record<string, string>)
					: {}
			const reviewRate = deviceRef.current.getSamplingRate?.() ?? null
			setSetupReview({
				deviceType: deviceType === "maker" ? "ScientISST Maker" : "ScientISST SENSE",
				connection:
					deviceType === "maker"
						? `${settings.baudRate ?? 9600} baud`
						: (settings.communication ?? SCIENTISST_COMUNICATION_MODE.WEBSERIAL) ===
						  SCIENTISST_COMUNICATION_MODE.WEBSOCKET
						? "WiFi"
						: "Bluetooth",
				samplingRate: Number.isFinite(reviewRate) ? (reviewRate as number) : null,
				channels: (deviceRef.current.getChannels?.() ?? [])
					.map(String)
					.filter(channel => !isIoPort(channel))
					.map(channel => ({
					channel,
					name: typeof reviewNames[channel] === "string" ? reviewNames[channel] : "",
					kind: typeof reviewKinds[channel] === "string" ? reviewKinds[channel] : "",
					axis:
						reviewKinds[channel] === "acc" && typeof reviewAxes[channel] === "string"
							? reviewAxes[channel]
							: ""
				}))
			})

			if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				window.electronAPI?.setBufferSize?.(
					storeBufferThresholdRef.current,
					deviceRef.current.getSamplingRate?.() || undefined
				)
			}
			setConnectWarning(null)
			setStatus(STATUS.CONNECTED)
		} catch (error) {
			deviceRef.current = null
			setSetupReview(null)

			if (error instanceof CancelledByUserException) {
				setStatus(STATUS.DISCONNECTED)
				return
			}
			console.error(error)
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
			cleanupPipeline();
			deviceRef.current = null;
			setSetupReview(null);
			setStatus(STATUS.DISCONNECTED);
		}
	}, [cleanupPipeline]);

	const handleUnexpectedAcquisitionStop = useCallback(() => {
		if (finalizingAfterErrorRef.current) return
		finalizingAfterErrorRef.current = true
		window.electronAPI?.logPerfEvent?.('connection_lost')
		disconnectedAtRef.current = Date.now()
		setDisconnectNotice(true)

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

			const adcCharacteristics = await device.getAdcCharacteristics?.();
			const adcChars: Record<string, number> = adcCharacteristics
				? {
						adcNum: adcCharacteristics.adcNum,
						adcAtten: adcCharacteristics.adcAtten,
						adcBitWidth: adcCharacteristics.adcBitWidth,
						coeffA: adcCharacteristics.coeffA,
						coeffB: adcCharacteristics.coeffB,
						vRef: adcCharacteristics.vRef
				  }
				: {};
			const firmwareVersion = device.getFirmwareVersion?.()?.version ?? undefined;

			const now = Date.now();
			const configuredSignalKinds =
				typeof settings.channelSignalKinds === "object" && settings.channelSignalKinds !== null
					? (settings.channelSignalKinds as Record<string, string>)
					: {}
			const configuredSignalAxes =
				typeof settings.channelSignalAxes === "object" && settings.channelSignalAxes !== null
					? (settings.channelSignalAxes as Record<string, string>)
					: {}
			const configuredChannelNames =
				typeof settings.channelNames === "object" && settings.channelNames !== null
					? (settings.channelNames as Record<string, string>)
					: {}
			const sessionChannels = (device.getChannels?.() ?? [])
				.map(String)
				.filter(channel => !isIoPort(channel))
			const channelSignalKinds = Object.fromEntries(
				Object.entries(configuredSignalKinds).filter(
					([channel, signalKind]) =>
						sessionChannels.includes(channel) &&
						typeof signalKind === "string" &&
						signalKind.length > 0
				)
			)
			const channelSignalAxes = Object.fromEntries(
				Object.entries(configuredSignalAxes).filter(
					([channel, axis]) =>
						sessionChannels.includes(channel) &&
						channelSignalKinds[channel] === "acc" &&
						typeof axis === "string" &&
						(axis === "x" || axis === "y" || axis === "z")
				)
			)
			const channelNames = Object.fromEntries(
				Object.entries(configuredChannelNames).filter(
					([channel, name]) =>
						sessionChannels.includes(channel) &&
						typeof name === "string" &&
						name.length > 0
				)
			)
			setLiveSignalKinds(channelSignalKinds)
			setLiveSignalAxes(channelSignalAxes)
			setLiveChannelNames(channelNames)
			await window.electronAPI?.createSession?.({
				sessionId: `${now}`,
				startedAt: now,
				sampleRate,
				channels: sessionChannels,
				...(getOrderedEegChannels(channelSignalKinds, sessionChannels).length > 0
					? { eegChannels: getOrderedEegChannels(channelSignalKinds, sessionChannels) }
					: {}),
				channelSignalKinds,
				channelSignalAxes,
				channelNames,
				sessionFolder,
				adcChars,
				firmwareVersion
			});
			await window.electronAPI?.registerSegment?.({
				index: segmentRef.current,
				startedAt: now,
				endedAt: null
			});

			if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current, sampleRate);
			}

			persistSessionMetadata();

			device.onFrames = data => {
				if (data == null) return;
				if (Array.isArray(data)) {
					const validFrames = data.filter(Boolean);
					if (validFrames.length === 0) return;
					window.electronAPI?.sendFrame?.(validFrames);
					framePublisher.publishFrames(validFrames);
				} else {
					window.electronAPI?.sendFrame?.(data);
					framePublisher.publishFrames([data]);
				}
			};

			device.onError = error => {
				if (isExpectedDeviceLoss(error)) {
					console.warn("[device.onError] Device stopped responding; ending the session and notifying the user.");
				} else {
					console.error("[device.onError] Unexpected acquisition error", error);
				}
				if (window.electronAPI?.acquisitionError && sessionFolder) {
					window.electronAPI.acquisitionError(sessionFolder);
				}
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
	}, [initializePipeline, persistSessionMetadata, handleUnexpectedAcquisitionStop, connectedDeviceLabel])

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

			if (Number.isFinite(storeBufferThresholdRef.current) && storeBufferThresholdRef.current > 0) {
				window.electronAPI?.setBufferSize?.(storeBufferThresholdRef.current, sampleRate);
			}

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
			window.electronAPI?.resetSession?.();
		};
	}, [cleanupPipeline])

	const xTickFormatter = useCallback((value: number) => {
		const samplingRate = deviceRef.current?.getSamplingRate?.() || 1
		const absoluteValue = value + xAxisOffsetFramesRef.current
		const time = samplingRate !== 0 ? absoluteValue / samplingRate : absoluteValue

		if (time < 0) return "0:00"

		const total = Math.round(time)
		const seconds = total % 60
		const minutes = Math.floor(total / 60)

		return seconds < 10 ? `${minutes}:0${seconds}` : `${minutes}:${seconds}`
	}, [])

	const secondTickFrames = (): number[] | undefined => {
		const windowFrames = uiWindowFramesRef.current
		const samplingRate = deviceRef.current?.getSamplingRate?.() || 0
		if (!windowFrames || !samplingRate) return undefined
		const ticks: number[] = []
		for (let second = 0; second * samplingRate <= windowFrames; second++) {
			ticks.push(second * samplingRate)
		}
		return ticks.length > 0 ? ticks : undefined
	}

	const [showCloseModal, setShowCloseModal] = useState(false);

	const statusRef = useRef(status);
	useEffect(() => { statusRef.current = status; }, [status]);

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
	}, []); 

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

	const renderIoDots = (ports: string[]) =>
		ports.map(io => {
			const on = activeChannels[io] ?? false
			return (
				<span
					key={io}
					className="flex items-center gap-2 text-sm font-secondary"
				>
					{io}
					<span
						title={on ? "Receiving" : "Not receiving"}
						aria-label={on ? "Receiving" : "Not receiving"}
						className={`h-3 w-3 rounded-full border-2 transition-colors ${
							on
								? "border-green-500 bg-green-500"
								: "border-over-background-highest bg-transparent"
						}`}
					/>
				</span>
			)
		})

	return (
		<SenseLayout
			className="container flex flex-col items-center justify-start gap-4 p-8"
			title="Live Acquisition"
			shortTitle="Live"
			returnHref="/"
		>
			<div
				role="status"
				aria-live="assertive"
				className={clsx(
					"fixed left-4 top-20 z-30 flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-sm font-medium text-white shadow-lg transition-opacity duration-300",
					disconnectNotice ? "opacity-100" : "pointer-events-none opacity-0"
				)}
			>
				Device disconnected - saving the recording
			</div>
			{status === STATUS.CONNECTED && (
				<div className="w-full max-w-2xl rounded-lg border border-background-accent bg-background-accent px-4 py-3 text-sm text-over-background-highest">
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<span>
							<span className="font-medium">{connectedDeviceLabel}</span>
							{firmwareVersion !== null && (
								<span className="ml-3 text-over-background-medium">Firmware: {firmwareVersion}</span>
							)}
						</span>
						<Link
							href="/settings"
							className="rounded-full bg-over-background-low-light px-3 py-1 text-xs font-medium uppercase tracking-wide text-over-background-high-light transition hover:opacity-80 dark:bg-over-primary-medium-light dark:text-over-background-highest-light"
						>
							Edit Settings
						</Link>
					</div>

					{setupReview && (
						<div className="mt-2 space-y-2 border-t border-background pt-2 text-xs">
							<div className="flex flex-wrap gap-x-6 gap-y-1">
								<span className="text-xs text-over-background-medium">
									Device:{" "}
									<span className="text-xs text-over-background-highest">{setupReview.deviceType}</span>
								</span>
								<span className="text-xs text-over-background-medium">
									Connection:{" "}
									<span className="text-xs text-over-background-highest">{setupReview.connection}</span>
								</span>
								{setupReview.samplingRate !== null && (
									<span className="text-xs text-over-background-medium">
										Sampling rate:{" "}
										<span className="text-xs text-over-background-highest">
											{setupReview.samplingRate} Hz
										</span>
									</span>
								)}
								{setupReview.channels.length > 0 && (
									<span className="text-xs text-over-background-medium">
										Channels:{" "}
										<span className="text-xs text-over-background-highest">
											{setupReview.channels.length}
										</span>
									</span>
								)}
							</div>

							{setupReview.channels.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{setupReview.channels.map(channel => {
										const kindLabel = signalKindLabel(channel.kind)
										return (
											<span
												key={channel.channel}
												className="inline-flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs"
											>
												<span className="text-xs font-medium text-over-background-highest">
													{channel.channel}
												</span>
												{channel.name && (
													<span className="text-xs text-over-background-medium">{channel.name}</span>
												)}
												<span
													className={
														kindLabel
															? "text-xs text-over-background-medium"
															: "text-xs text-over-background-low"
													}
												>
													{kindLabel
														? `${kindLabel}${
																channel.axis ? ` ${channel.axis.toUpperCase()}` : ""
														  }`
														: "no signal type"}
												</span>
											</span>
										)
									})}
								</div>
							)}

							{setupReview.channels.length > 0 && (
								<p className="text-xs text-over-background-low">
									Check this before starting. Signal types are what the analysis on the processing
									page uses, so channels left without one are recorded but not analysed.
								</p>
							)}
						</div>
					)}
				</div>
			)}
			<div className="relative flex w-full flex-row items-center justify-center gap-4">				{(status === STATUS.DISCONNECTED ||
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
						{status === STATUS.ACQUIRING && (
							<div className="absolute left-4 flex flex-row gap-6">
								{renderIoDots(IO_INPUTS)}
							</div>
						)}
						<TextButton
							size={"base"}
							onClick={status === STATUS.PAUSED ? resume : pause}
						>
							{status === STATUS.PAUSED ? "Resume" : "Pause"}
						</TextButton>
						<TextButton size={"base"} onClick={stop}>
							Stop
						</TextButton>
						{status === STATUS.ACQUIRING && (
							<div className="absolute right-4 flex flex-row gap-6">
								{renderIoDots(IO_OUTPUTS)}
							</div>
						)}
					</>
				)}
			</div>
			{connectWarning && (
				<span className="max-w-md text-center text-sm text-over-background-medium">⚠️ {connectWarning}</span>
			)}
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
							acc[channel] = liveChannelNames[channel] ?? "";
							return acc;
						},
						{} as Record<string, string>
					)
					}}
					onSubmit={async values => {
						const { channelName } = values;
						setLiveChannelNames(channelName);
						window.electronAPI?.setChannelNames?.(channelName);
						writeLiveSettingsPatch({ channelNames: channelName });
					}}
				>
					<Form className="flex w-full flex-col gap-4">
						<FormikAutoSubmit delay={100} />
						{channels.map(channel => {
							const kind = liveSignalKinds[channel] ?? "";
							const axis = liveSignalAxes[channel] ?? "";
							return (
								<Fragment key={channel}>
									<div className="flex w-full flex-row gap-4">
										<TextField
											id={`channelName.${channel}`}
											name={`channelName.${channel}`}
											className="mb-0"
											placeholder={channel}
										/>
										<select
											value={kind}
											onChange={(event) => {
												const nextKind = event.target.value;
												setLiveSignalKinds(prev => {
													const next = { ...prev };
													if (!nextKind) delete next[channel]; else next[channel] = nextKind;
													const nextEegChannels = getOrderedEegChannels(next, channels)
													window.electronAPI?.updateSessionMeta?.({
														channelSignalKinds: next,
														eegChannels: nextEegChannels
													});
													writeLiveSettingsPatch({ channelSignalKinds: next, eegChannels: nextEegChannels });
													return next;
												});
												setLiveSignalAxes(prev => {
													const next = { ...prev };
													if (nextKind === "acc") {
														if (!next[channel]) next[channel] = "x";
													} else {
														if (!(channel in next)) return prev;
														delete next[channel];
													}
													window.electronAPI?.updateSessionMeta?.({ channelSignalAxes: next });
													writeLiveSettingsPatch({ channelSignalAxes: next });
													return next;
												});
											}}
											className="h-12 min-w-[6rem] rounded-md border border-background-accent bg-background px-2 py-0 text-xs text-over-background-highest outline-none"
										>
											{LIVE_SIGNAL_TYPE_OPTIONS.map(option => (
												<option key={`${channel}-kind-${option.value || "empty"}`} value={option.value}>
													{option.label}
												</option>
											))}
										</select>
										{kind === "acc" && (
											<select
												value={axis}
												onChange={(event) => {
													const nextAxis = event.target.value;
													setLiveSignalAxes(prev => {
														const next = { ...prev };
														if (!nextAxis) delete next[channel]; else next[channel] = nextAxis;
														window.electronAPI?.updateSessionMeta?.({ channelSignalAxes: next });
														writeLiveSettingsPatch({ channelSignalAxes: next });
														return next;
													});
												}}
												className="h-12 min-w-[4rem] rounded-md border border-background-accent bg-background px-2 py-0 text-sm text-over-background-highest outline-none"
											>
												{LIVE_ACC_AXIS_OPTIONS.map(option => (
													<option key={`${channel}-axis-${option.value || "empty"}`} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										)}
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
												xTickValues={secondTickFrames()}
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
						className="rounded-lg shadow-lg p-8 max-w-md w-full text-over-background-highest-dark"
						style={{ backgroundColor: `${backgroundDarkColor}E6` }}
					>
						<h2 className="text-xl font-bold mb-4 text-over-background-highest-dark">Ongoing Acquisition</h2>
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