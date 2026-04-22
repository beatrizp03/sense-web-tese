import * as semver from "semver"

import { SCIENTISST_CHANNEL } from "../devices"
import { Frame } from "../frames"
import { ScientISSTFrame } from "../frames/ScientISSTFrame"
import { Transport } from "../transport"
import { FrameReader } from "./FrameReader"
import { TooManyFramesLostException } from "./exceptions/TooManyFramesLostException"

/**
 * This frame reader is responsible for reading frames from a stream using the
 * ScientISST protocol.
 */
export class ScientISSTFrameReader implements FrameReader {
	private readonly transport: Transport
	private readonly channels: SCIENTISST_CHANNEL[]
	private readonly firmwareVersion: semver.SemVer
	private readonly bytesPerFrame: number
	private static crc4Table: number[] = [
		0, 3, 6, 5, 12, 15, 10, 9, 11, 8, 13, 14, 7, 4, 1, 2
	]

	constructor(
		transport: Transport,
		channels: Set<SCIENTISST_CHANNEL>,
		firmwareVersion: semver.SemVer
	) {
		this.transport = transport
		this.channels = Array(...channels.values())
			.sort()
			.reverse()
		this.firmwareVersion = firmwareVersion

		// Calculate the number of bytes per frame
		const internalChannelsCount = this.channels.filter(
			channel =>
				channel === "AI1" ||
				channel === "AI2" ||
				channel === "AI3" ||
				channel === "AI4" ||
				channel === "AI5" ||
				channel === "AI6"
		).length
		const externalChannelsCount = this.channels.filter(
			channel => channel === "AX1" || channel === "AX2"
		).length

		this.bytesPerFrame = 3 * externalChannelsCount + 2

		if (this.firmwareVersion.major >= 2) {
			this.bytesPerFrame += 1
		}

		if (internalChannelsCount % 2) {
			this.bytesPerFrame += (internalChannelsCount * 12 - 4) / 8
		} else {
			this.bytesPerFrame += (internalChannelsCount * 12) / 8
		}
	}

	private isValidFrame(frame: Uint8Array): boolean {
		if (frame.length != this.bytesPerFrame) {
			return false
		}

		let crc = 0
		let b: number

		if (this.firmwareVersion.major < 2) {
			for (let i = 0; i < frame.length - 1; i++) {
				b = frame[i]
				crc = ScientISSTFrameReader.crc4Table[crc] ^ (b >> 4)
				crc = ScientISSTFrameReader.crc4Table[crc] ^ (b & 0x0f)
			}

			crc =
				ScientISSTFrameReader.crc4Table[crc] ^
				(frame[frame.length - 1] >> 4)
			crc = ScientISSTFrameReader.crc4Table[crc]

			return crc == (frame[frame.length - 1] & 0x0f)
		} else {
			for (let i = 0; i < frame.length - 2; i++) {
				b = frame[i]
				crc = ScientISSTFrameReader.crc4Table[crc] ^ (b >> 4)
				crc = ScientISSTFrameReader.crc4Table[crc] ^ (b & 0x0f)
			}

			crc =
				ScientISSTFrameReader.crc4Table[crc] ^
				(frame[frame.length - 2] >> 4)
			crc =
				ScientISSTFrameReader.crc4Table[crc] ^
				(frame[frame.length - 1] >> 4)
			crc =
				ScientISSTFrameReader.crc4Table[crc] ^
				(frame[frame.length - 1] & 0x0f)
			crc = ScientISSTFrameReader.crc4Table[crc]

			return crc == (frame[frame.length - 2] & 0x0f)
		}
	}

	public async readFrames(
		frames: number,
		timeoutMilliseconds: number
	): Promise<Frame[]> {
		const result: Frame[] = []
		let buffer = await this.transport.read(
			this.bytesPerFrame * frames,
			timeoutMilliseconds
		)
		// The TOTAL number of bytes skipped due to invalid frames
		let offset = 0

		for (let i = 0; i < frames; i++) {
			let frameBytes = buffer.slice(
				this.bytesPerFrame * i + offset,
				this.bytesPerFrame * (i + 1) + offset
			)

			// If the frame is invalid, skip one byte until we find a valid
			// frame

			let skippedBytes = 0 // The number of bytes skipped in this iteration
			const resyncStart = Date.now();
			const MAX_RESYNC_MS = 3000; // 3 seconds
			
			while (!this.isValidFrame(frameBytes)) {
				if (Date.now() - resyncStart > MAX_RESYNC_MS) {
					console.error(`Resync timeout: skipped ${skippedBytes} bytes in ${Date.now() - resyncStart} ms`);
					throw new TooManyFramesLostException(this);
				}
				console.log("Invalid byte")
				// Fetch one more byte
				buffer = new Uint8Array([
					...buffer,
					...(await this.transport.read(1, timeoutMilliseconds))
				])
				frameBytes = buffer.slice(
					this.bytesPerFrame * i + offset,
					this.bytesPerFrame * (i + 1) + offset
				)

				// Increment the number of skipped bytes
				offset++
				skippedBytes++

				// Throw an exception if we have skipped too many bytes
				if (
					(this.firmwareVersion.major >= 2 &&
						skippedBytes >= this.bytesPerFrame * 4094) ||
					(this.firmwareVersion.major < 2 &&
						skippedBytes >= this.bytesPerFrame * 14)
				) {
					console.error(`Too many frames lost: skipped ${skippedBytes} bytes while trying to read ${frames} frames.`)
					throw new TooManyFramesLostException(this)
				}
			}

			const sequenceNumber =
				this.firmwareVersion.major >= 2
					? (frameBytes[frameBytes.length - 2] >> 4) |
					  (frameBytes[frameBytes.length - 1] << 4)
					: frameBytes[frameBytes.length - 1] >> 4

			const frameValues: Partial<Record<SCIENTISST_CHANNEL, number>> = {}

			// The number of processed bytes in the current frame
			let frameByteOffset = 0
			// Whether we have already processed half of the current byte
			let middle = false

			// Iterate over all channels and extract the values
			for (let j = 0; j < this.channels.length; j++) {
				const channel = this.channels[j]

				switch (channel) {
					case "AX1":
					case "AX2":
						frameValues[channel] =
							frameBytes[frameByteOffset] |
							(frameBytes[frameByteOffset + 1] << 8) |
							(frameBytes[frameByteOffset + 2] << 16)

						frameByteOffset += 3
						break
					case "I1":
						frameValues[channel] =
							this.firmwareVersion.major >= 2
								? (frameBytes[frameBytes.length - 3] >> 7) &
								  0x01
								: (frameBytes[frameBytes.length - 2] >> 7) &
								  0x01
						break
					case "I2":
						frameValues[channel] =
							this.firmwareVersion.major >= 2
								? (frameBytes[frameBytes.length - 3] >> 6) &
								  0x01
								: (frameBytes[frameBytes.length - 2] >> 6) &
								  0x01
						break
					case "O1":
						frameValues[channel] =
							this.firmwareVersion.major >= 2
								? (frameBytes[frameBytes.length - 3] >> 5) &
								  0x01
								: (frameBytes[frameBytes.length - 2] >> 5) &
								  0x01
						break
					case "O2":
						frameValues[channel] =
							this.firmwareVersion.major >= 2
								? (frameBytes[frameBytes.length - 3] >> 4) &
								  0x01
								: (frameBytes[frameBytes.length - 2] >> 4) &
								  0x01
						break
					case "AI1":
					case "AI2":
					case "AI3":
					case "AI4":
					case "AI5":
					case "AI6":
						if (middle) {
							frameValues[channel] =
								((frameBytes[frameByteOffset + 1] << 8) |
									frameBytes[frameByteOffset]) >>
								4

							frameByteOffset += 2
						} else {
							frameValues[channel] =
								((frameBytes[frameByteOffset + 1] << 8) |
									frameBytes[frameByteOffset]) &
								0xfff

							frameByteOffset += 1
						}

						middle = !middle

						break
					default:
						throw new Error(`Unknown channel ${channel}`)
				}
			}

			// Add the frame to the result
			result.push(new ScientISSTFrame(frameValues, sequenceNumber))
		}

		return result
	}
}
