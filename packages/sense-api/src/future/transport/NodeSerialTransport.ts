import { Mutex } from "../locks"
import { Transport } from "./Transport"
import {
	AlreadyConnectedException,
	CancelledByUserException,
	ConnectionFailedException,
	ConnectionLostException,
	NotConnectedException,
	PermissionDeniedException
} from "./exceptions"
import { TransportClosedException } from "./exceptions/TransportClosedException"

/**
 * A transport implementation that runs inside Electron's renderer/main
 * process and talks to a serial port via the preload bridge.  This is used
 * when the desktop application is running offline; the transport mimics the
 * behaviour of WebSerialTransport but bypasses the browser API entirely.
 */
export class NodeSerialTransport implements Transport {
	// path returned by the native chooser, or null when closed
	private electronPortPath: string | null = null

	// small helper locks to serialize read/write operations
	private readLock = new Mutex()
	private writeLock = new Mutex()

	// buffer leftover from previous reads (mirrors WebSerialTransport behaviour)
	private readBuffer = new Uint8Array(0)

	// identical signature to WebSerialTransport so that the higher levels can
	// treat both transports interchangeably.
	constructor(private baudRate: number, private bufferSize: number) {}

	isOpen(): boolean {
		return this.electronPortPath !== null
	}

	async open(): Promise<void> {
		if (this.isOpen()) {
			throw new AlreadyConnectedException(this)
		}

		// ask the main process to pick a port for us
		const api = (window as any).electronAPI
		if (!api) {
			throw new Error("NodeSerialTransport requires electronAPI")
		}

		try {
			this.electronPortPath = await api.requestPort()
		} catch (e) {
			if (
				e &&
				(e.message === "Cancelled" ||
					 e.message === "No serial ports available")
			) {
				throw new CancelledByUserException(this)
			}
			throw e
		}

		// open the chosen port at the desired baud rate
		await api.openSerialPort(this.electronPortPath, { baudRate: this.baudRate })
	}

	async close(): Promise<void> {
		if (this.electronPortPath) {
			await (window as any).electronAPI.closeSerialPort(
				this.electronPortPath
			)
			this.electronPortPath = null
		}
	}

	async write(data: Uint8Array): Promise<void> {
		if (!this.isOpen()) {
			throw new NotConnectedException(this)
		}

		await this.writeLock.acquire()

		if (!this.isOpen()) {
			this.writeLock.release()
			throw new ConnectionLostException(this)
		}

		try {
			await (window as any).electronAPI.writeSerialPort(
				this.electronPortPath,
				data
			)
		} finally {
			this.writeLock.release()
		}
	}

	async read(bytes: number, timeoutMilliseconds: number): Promise<Uint8Array> {
		if (!this.isOpen()) {
			throw new NotConnectedException(this)
		}

		await this.readLock.acquire()

		if (!this.isOpen()) {
			this.readLock.release()
			throw new ConnectionLostException(this)
		}

		try {
			// serve from local buffer first
			if (this.readBuffer.length >= bytes) {
				const slice = this.readBuffer.slice(0, bytes)
				this.readBuffer = this.readBuffer.slice(bytes)
				return slice
			}

			// need more data from native side
			const needed = bytes - this.readBuffer.length
			const chunk: Uint8Array = await (window as any).electronAPI.readSerialPort(
				this.electronPortPath,
				needed,
				timeoutMilliseconds
			)

			// concatenate with whatever was buffered
			const combined = new Uint8Array(this.readBuffer.length + chunk.length)
			combined.set(this.readBuffer, 0)
			combined.set(chunk, this.readBuffer.length)
			this.readBuffer = combined

			// now slice out the requested amount and keep remainder
			if (this.readBuffer.length <= bytes) {
				const slice = this.readBuffer
				this.readBuffer = new Uint8Array(0)
				return slice
			} else {
				const slice = this.readBuffer.slice(0, bytes)
				this.readBuffer = this.readBuffer.slice(bytes)
				return slice
			}
		} finally {
			this.readLock.release()
		}
	}
}
