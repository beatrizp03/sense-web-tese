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
 * Transport that uses the Web Serial API to communicate with a device.
 */
export class WebSerialTransport implements Transport {
	private device?: SerialPort
	private readonly baudRate: number
	private readonly bufferSize: number
	private readBuffer = new Uint8Array(0)
	private readLock = new Mutex()
	private writeLock = new Mutex()
	private reader?: ReadableStreamDefaultReader<unknown>
	private writer?: WritableStreamDefaultWriter<unknown>

	/**
	 * Create a new WebSerialTransport.
	 * @param {number} baudRate the baud rate to use
	 * @param {number} bufferSize the size of the read buffer, in bytes
	 */
	constructor(baudRate: number, bufferSize: number) {
		// Check if we're running in a browser
		if (typeof window === "undefined") {
			throw new Error("WebSerialTransport is only available in a browser")
		}

		// Check if the Web Serial API is available
		if (!("serial" in navigator)) {
			throw new Error(
				"WebSerialTransport is not available in this browser"
			)
		}

		// Check if baudRate is a positive integer
		if (!Number.isInteger(baudRate) || baudRate <= 0) {
			throw new Error("baudRate must be a positive integer")
		}

		// Check if bufferSize is a positive integer
		if (!Number.isInteger(bufferSize) || bufferSize <= 0) {
			throw new Error("bufferSize must be a positive integer")
		}

		this.baudRate = baudRate
		this.bufferSize = bufferSize
	}

	/**
	 * Returns true if the current device is a MacOS device
	 */
	private isMacOS(): boolean {
		return (
			navigator &&
			typeof navigator.userAgent === "string" &&
			navigator.userAgent.includes("Mac OS")
		)
	}

	async open() {
		if (this.isOpen()) {
			throw new AlreadyConnectedException(this)
		}

		// Request the user to select a serial port
		try {
			this.device = await navigator.serial.requestPort()
			this.readBuffer = new Uint8Array(0)
		} catch (e) {
			if (e instanceof DOMException && e.name === "NotFoundError") {
				throw new CancelledByUserException(this)
			} else if (
				e instanceof DOMException &&
				e.name === "SecurityError"
			) {
				throw new PermissionDeniedException(this)
			}

			// Unhandled exceptions
			throw e
		}

		// Open the serial port
		try {
			// DO NOT REMOVE THIS TIMEOUT
			// MacOS WILL NOT WORK WITHOUT IT
			if (this.isMacOS()) {
				await new Promise(resolve => {
					setTimeout(resolve, 2000)
				})
			}
			await this.device.open({
				baudRate: this.baudRate,
				bufferSize: this.bufferSize
			})
			// DO NOT REMOVE THIS TIMEOUT
			// MacOS WILL NOT WORK WITHOUT IT
			if (this.isMacOS()) {
				await new Promise(resolve => {
					setTimeout(resolve, 8000)
				})
			}
		} catch (e) {
			this.device = undefined

			if (e instanceof DOMException && e.name === "InvalidStateError") {
				throw new AlreadyConnectedException(this)
			} else if (e instanceof DOMException && e.name === "NetworkError") {
				throw new ConnectionFailedException(this)
			}

			// Unhandled exceptions
			throw e
		}
	}

	isOpen(): boolean {
		return !!(this.device && this.device.readable && this.device.writable)
	}

	async close() {
		// If the serial port is already closed, do nothing
		if (!this.device) return
		const device = this.device
		this.device = undefined
		const reader = this.reader
		this.reader = undefined
		const writer = this.writer
		this.writer = undefined

		// Cancel all pending read and write operations
		const error = new TransportClosedException(this)
		this.readLock.cancel(error)
		this.writeLock.cancel(error)

		try {
			if (reader) {
				await reader.cancel()
			}
		} catch (e) {
			// Ignore
		}

		try {
			if (writer) {
				await writer.abort()
			}
		} catch (e) {
			// Ignore
		}

		// Close the serial port
		try {
			await device.close()
		} catch (e) {
			if (e instanceof DOMException && e.name === "InvalidStateError") {
				// The serial port is already closed
				return
			}

			// Unhandled exceptions
			throw e
		}
	}

	async write(data: Uint8Array) {
		if (!this.isOpen()) {
			throw new NotConnectedException(this)
		}

		await this.writeLock.acquire()

		if (!this.isOpen()) {
			throw new ConnectionLostException(this)
		}

		try {
			const writer = this.device.writable.getWriter()
			this.writer = writer
			try {
				// DO NOT REMOVE THIS CONSOLE.LOG
				// IF REMOVED, IT WILL BREAK THE APPLICATION FOR MacOS
				if (this.isMacOS()) {
					console.log("Sending...", data)
				}
				await writer.write(data)
			} catch (e) {
				if (e instanceof DOMException && e.name === "NetworkError") {
					throw new ConnectionLostException(this)
				}
				throw e
			} finally {
				writer.releaseLock()
				this.writer = undefined
			}
		} catch (e) {
			await this.close()
			this.writeLock.cancel(e)
			this.readLock.cancel(e)
			throw e
		}

		this.writeLock.release()
	}

	async read(bytes: number, timeoutMilliseconds: number) {
		if (!this.isOpen()) {
			throw new NotConnectedException(this)
		}

		// Wait for the read lock
		await this.readLock.acquire()

		if (!this.isOpen()) {
			throw new ConnectionLostException(this)
		}

		const result = new Uint8Array(bytes)
		let bytesRead = 0

		// Read from the read buffer
		if (this.readBuffer.length > 0) {
			const bytesToRead = Math.min(this.readBuffer.length, bytes)
			result.set(this.readBuffer.slice(0, bytesToRead))
			this.readBuffer = this.readBuffer.slice(bytesToRead)
			bytesRead += bytesToRead
		}

		if (bytesRead === bytes) {
			this.readLock.release()
			return result
		}

		// Read from the serial port
		const reader = this.device.readable.getReader()
		this.reader = reader
		let timeoutId: NodeJS.Timeout | null = null
		try {
			try {
				if (timeoutMilliseconds > 0) {
					timeoutId = setTimeout(() => {
						// Announce that we're no longer interested in the
						// stream
						reader.cancel()
					}, timeoutMilliseconds)
				}

				do {
					const { value, done } = await reader.read()

					// The serial port was closed or the read timed out
					if (done || value === undefined) {
						throw new ConnectionLostException(this)
					}

					const bytesToRead = Math.min(
						value.length,
						bytes - bytesRead
					)
					result.set(value.slice(0, bytesToRead), bytesRead)
					bytesRead += bytesToRead
					if (bytesToRead < value.length) {
						this.readBuffer = value.slice(bytesToRead)
					}
				} while (bytesRead < bytes)
			} catch (e) {
				if (e instanceof DOMException && e.name === "NetworkError") {
					throw new ConnectionLostException(this)
				}
				throw e
			} finally {
				if (timeoutId !== null) {
					clearTimeout(timeoutId)
				}
				reader.releaseLock()
				this.reader = undefined
			}
		} catch (e) {
			await this.close()
			this.readLock.cancel(e)
			this.writeLock.cancel(e)
			throw e
		}

		this.readLock.release()
		return result
	}
}
