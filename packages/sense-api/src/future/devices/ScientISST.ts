import { SemVer } from "semver"

import { ScientISSTAdcCharacteristics } from "../adcCharacteristics"
import { Frame } from "../frames"
import { FrameReader, ScientISSTFrameReader } from "../readers"
import {
	Transport,
	WebSerialTransport,
	WebSocketTransport
} from "../transport"
import { NodeSerialTransport } from "../transport/NodeSerialTransport"
import { DEVICE_STATUS, Device } from "./Device"
import { NotAcquiringException, NotIdleException } from "./exceptions"

export enum SCIENTISST_COMUNICATION_MODE {
	WEBSOCKET = 0,
	WEBSERIAL = 1
}

export type SCIENTISST_CHANNEL =
	| "AI1"
	| "AI2"
	| "AI3"
	| "AI4"
	| "AI5"
	| "AI6"
	| "AX1"
	| "AX2"
	| "I1"
	| "I2"
	| "O1"
	| "O2"

export class ScientISST implements Device {
	private status: DEVICE_STATUS = DEVICE_STATUS.DISCONNECTED
	private readonly transport: Transport
	private frameReader: FrameReader | null = null
	private readonly channels: Set<SCIENTISST_CHANNEL>
	private readonly samplingRate: number
	private version: SemVer | null = null
	private adcCharacteristics: ScientISSTAdcCharacteristics | null = null
	private timeoutID: NodeJS.Timeout | null = null

	constructor(
		communicationMode: SCIENTISST_COMUNICATION_MODE,
		channels: Set<SCIENTISST_CHANNEL>,
		samplingRate: number,
		transportOverride?: Transport
	) {
		this.channels = channels
		this.samplingRate = samplingRate

		if (transportOverride) {
			this.transport = transportOverride
		} else if (
			typeof window !== "undefined" &&
			typeof (window as any).electronAPI !== "undefined"
		) {
			// running inside Electron – use native node serial transport regardless
			// of the chosen communication mode (BLE support was removed earlier)
			this.transport = new NodeSerialTransport(9600, 2 ** 20)
		} else {
			switch (communicationMode) {
				case SCIENTISST_COMUNICATION_MODE.WEBSERIAL:
					this.transport = new WebSerialTransport(9600, 2 ** 20)
					break
				case SCIENTISST_COMUNICATION_MODE.WEBSOCKET:
					this.transport = new WebSocketTransport(
						"wss://scientisst.local",
						2 ** 20
					)
					break
				default:
					throw new Error("Communication mode not implemented.")
			}
		}
	}

	private async acquire(): Promise<void> {
		try {
			const frames = await this.frameReader?.readFrames(
				Math.ceil(this.samplingRate / 24),
				2500
			)
			if (this.timeoutID !== null) {
				if (this.status === DEVICE_STATUS.ACQUIRING) {
					await this.onFrames(frames)
				}

				this.timeoutID = setTimeout(async () => {
					await this.acquire()
				}, 0)
			}
		} catch (e) {
			if (this.timeoutID === null) {
				return
			}

			await this.disconnect()
			await this.onError(e)
		}
	}

	private async readString(): Promise<string> {
		let byte = (await this.transport.read(1, 5000))[0]
		let string = ""

		while (byte !== 0x00) {
			string += String.fromCharCode(byte)
			byte = (await this.transport.read(1, 5000))[0]
		}

		return string
	}

	private async readUint32(): Promise<number> {
		const bytes = await this.transport.read(4, 5000)
		return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
	}

	async connect(): Promise<void> {
		this.status = DEVICE_STATUS.CONNECTING

		try {
			await this.transport.open()

			// Set device to ScientISST mode
			await this.transport.write(new Uint8Array([0x23]))

			// Read version and ADC characteristics
			await this.transport.write(new Uint8Array([0x07]))
			try {
				this.version = new SemVer(await this.readString())
			} catch {
				this.version = new SemVer("1.0.0")
			}
			this.adcCharacteristics = new ScientISSTAdcCharacteristics(
				await this.readUint32(),
				await this.readUint32(),
				await this.readUint32(),
				await this.readUint32(),
				await this.readUint32(),
				await this.readUint32()
			)

			this.frameReader = new ScientISSTFrameReader(
				this.transport,
				this.channels,
				this.version
			)

			this.status = DEVICE_STATUS.IDLE
		} catch (error) {
			await this.transport.close()
			this.status = DEVICE_STATUS.DISCONNECTED
			throw error
		}
	}

	async disconnect(): Promise<void> {
		this.status = DEVICE_STATUS.DISCONNECTED

		if (this.timeoutID !== null) {
			clearTimeout(this.timeoutID)
			this.timeoutID = null

			try {
				// Send command to stop acquisition for good measure
				await this.transport.write(new Uint8Array([0x00]))
			} catch (e) {
				// Ignore. The connection may or may not have failed at this
				// point
			}
		}

		await this.transport.close()
	}

	getStatus(): DEVICE_STATUS {
		return this.status
	}

	isConnecting(): boolean {
		return this.status === DEVICE_STATUS.CONNECTING
	}

	isConnected(): boolean {
		return (
			(this.status === DEVICE_STATUS.IDLE ||
				this.status === DEVICE_STATUS.ACQUIRING) &&
			this.transport.isOpen()
		)
	}

	isIdle(): boolean {
		return this.isConnected() && this.status === DEVICE_STATUS.IDLE
	}

	isAcquiring(): boolean {
		return this.isConnected() && this.status === DEVICE_STATUS.ACQUIRING
	}

	async startAcquisition(): Promise<void> {
		if (!this.isIdle()) {
			throw new NotIdleException(this)
		}

		if (this.timeoutID === null) {
			// Set sampling rate
			await this.transport.write(
				new Uint8Array([
					0x43,
					this.samplingRate & 0xff,
					(this.samplingRate >> 8) & 0xff
				])
			)

			// Start acquisition
			await this.transport.write(
				new Uint8Array([
					0x01,
					(this.channels.has("AI1") ? 1 : 0) |
						(this.channels.has("AI2") ? 1 << 1 : 0) |
						(this.channels.has("AI3") ? 1 << 2 : 0) |
						(this.channels.has("AI4") ? 1 << 3 : 0) |
						(this.channels.has("AI5") ? 1 << 4 : 0) |
						(this.channels.has("AI6") ? 1 << 5 : 0) |
						(this.channels.has("AX1") ? 1 << 6 : 0) |
						(this.channels.has("AX2") ? 1 << 7 : 0)
				])
			)

			this.timeoutID = setTimeout(async () => {
				await this.acquire()
			}, 0)
		}

		this.status = DEVICE_STATUS.ACQUIRING
	}

	async stopAcquisition(): Promise<void> {
		if (!this.isAcquiring()) {
			throw new NotAcquiringException(this)
		}

		this.status = DEVICE_STATUS.IDLE
	}

	public async onFrames(frames: Frame[]): Promise<void> {
		console.log(frames)
	}

	public async onError(error: unknown): Promise<void> {
		console.error(error)
	}

	public getFirmwareVersion(): SemVer | null {
		if (!this.isConnected()) {
			return null
		}

		return this.version
	}
	public getAdcCharacteristics(): ScientISSTAdcCharacteristics | null {
		if (!this.isConnected()) {
			return null
		}

		return this.adcCharacteristics
	}

	public getSamplingRate(): number {
		return this.samplingRate
	}

	public getChannels(): string[] {
		return Array.from(this.channels).sort()
	}
}
