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
			// Reset buffer before opening
			this.readBuffer = new Uint8Array(0);
			throw new AlreadyConnectedException(this);
		}
		const api = (window as any).electronAPI;
		if (!api) throw new Error("NodeSerialTransport requires electronAPI");
       try {
	       this.electronPortPath = await api.requestPort();
       } catch (e) {
	       // Map user cancellation or no available ports
	       if (e && (e.message === "Cancelled" || e.message === "No serial ports available")) {
		       throw new CancelledByUserException(this);
	       }
	       throw e;
       }
       // Add a longer delay before opening the port to allow OS/device to fully release it
	   //console.log("[NodeSerialTransport - 10000] Port selected, waiting for OS to release...");
	   //await new Promise(resolve => setTimeout(resolve, 10000));
       try {
	       await api.openSerialPort(this.electronPortPath, { baudRate: this.baudRate });
		   console.log('[OPEN - nodeserial] Port opened', this.electronPortPath);
       } catch (e) {
	       if (e.message && e.message.includes("busy")) {
		       console.error("[NodeSerialTransport] Port is busy. Try unplugging/replugging the device or restarting the app.");
		       throw new ConnectionFailedException(this);
	       }
	       if (e.message && e.message.includes("invalid byte")) {
		       console.error("[NodeSerialTransport] Invalid byte error. Device may need a hardware reset or power cycle.");
		       throw new ConnectionFailedException(this);
	       }
	       // Map port open failures
	       if (e.message && e.message.includes("NetworkError")) {
		       throw new ConnectionFailedException(this);
	       }
	       throw e;
       }
	}

	       async close(): Promise<void> {
		       if (this.electronPortPath) {
			// Reset locks and buffer for reuse
			this.readLock = new Mutex();
			this.writeLock = new Mutex();
			       await (window as any).electronAPI.closeSerialPort(
				       this.electronPortPath
			       )
			       console.log('[CLOSE - nodeserial] Closing port', this.electronPortPath);
			       this.electronPortPath = null;
			       // Add a delay after closing the port to allow OS/device to fully release it
				   //console.log("[NodeSerialTransport - 9000] Port closed, waiting for OS to release...");
				   //await new Promise(resolve => setTimeout(resolve, 9000));
		       }
		       // Cancel all pending read and write operations
		       const error = new TransportClosedException(this);
		       this.readLock.cancel(error);
		       this.writeLock.cancel(error);

		       // Clear local read buffer to avoid stale data on reconnect
			this.readBuffer = new Uint8Array(0);
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
			   const start = Date.now();
			   const chunk: Uint8Array = await (window as any).electronAPI.readSerialPort(
				   this.electronPortPath,
				   needed,
				   timeoutMilliseconds
			   );
			   const end = Date.now();
			   if (process.env.FRAME_TIMING_LOGS === '1') {
					console.log(`[electron][NodeSerialTransport] readSerialPort resolved at ${end} (duration ${end - start} ms) with ${chunk.length} bytes`);
				}

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
