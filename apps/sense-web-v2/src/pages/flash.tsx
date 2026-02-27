import { useCallback, useRef, useState } from "react"

import { chakra } from "@chakra-ui/react"
import { ESPLoader, Transport } from "esptool-js"

enum CONNECTION_STATE {
	DISCONNECTED,
	CONNECTING,
	DOWNLOADING,
	ERASING,
	FLASHING,
	FLASHED
}

const Page = () => {
	const [state, setState] = useState(CONNECTION_STATE.DISCONNECTED)

	const deviceRef = useRef<SerialPort>()
	const transportRef = useRef<Transport>()

	const actionConnect = useCallback(async () => {
		try {
			setState(CONNECTION_STATE.CONNECTING)

			deviceRef.current = await navigator.serial.requestPort()
			transportRef.current = new Transport(deviceRef.current)

			const esploader = new ESPLoader(transportRef.current, 9600)
			const chip = await esploader.main_fn()
			console.log(chip)

			setState(CONNECTION_STATE.DOWNLOADING)
			const partitionTable = await fetch("/firmware/partition-table.bin")
				.then(res => res.arrayBuffer())
				.then(buffer => {
					// Convert the buffer to a binary string
					let binaryString = ""
					const bytes = new Uint8Array(buffer)
					for (let i = 0; i < bytes.length; i++) {
						binaryString += String.fromCharCode(bytes[i])
					}
					return binaryString
				})
			const scientisstSense = await fetch(
				"/firmware/scientisst-sense.bin"
			)
				.then(res => res.arrayBuffer())
				.then(buffer => {
					// Convert the buffer to a binary string
					let binaryString = ""
					const bytes = new Uint8Array(buffer)
					for (let i = 0; i < bytes.length; i++) {
						binaryString += String.fromCharCode(bytes[i])
					}
					return binaryString
				})
			const www = await fetch("/firmware/www.bin")
				.then(res => res.arrayBuffer())
				.then(buffer => {
					// Convert the buffer to a binary string
					let binaryString = ""
					const bytes = new Uint8Array(buffer)
					for (let i = 0; i < bytes.length; i++) {
						binaryString += String.fromCharCode(bytes[i])
					}
					return binaryString
				})

			// Download bootloader binary from /firmware/bootloader.bin as binary string
			const bootloader = await fetch("/firmware/bootloader.bin")
				.then(res => res.arrayBuffer())
				.then(buffer => {
					// Convert the buffer to a binary string
					let binaryString = ""
					const bytes = new Uint8Array(buffer)
					for (let i = 0; i < bytes.length; i++) {
						binaryString += String.fromCharCode(bytes[i])
					}
					return binaryString
				})

			console.log(bootloader)

			setState(CONNECTION_STATE.ERASING)
			await esploader.erase_flash()

			setState(CONNECTION_STATE.FLASHING)
			const fileArrays = [
				{
					data: partitionTable,
					address: 0x8000
				},
				{
					data: bootloader,
					address: 0x1000
				},
				{
					data: scientisstSense,
					address: 0x10000
				},
				{
					data: www,
					address: 0x210000
				}
			]

			await esploader.write_flash(fileArrays, "4MB", "dio", "40m")

			// Close the connection
			await transportRef.current.disconnect()
			await transportRef.current.waitForUnlock(1500)

			setState(CONNECTION_STATE.FLASHED)
		} catch (error) {
			console.error(error)
			setState(CONNECTION_STATE.DISCONNECTED)
		}
	}, [])

	return (
		<chakra.div display="flex" flexDirection="column" gap="4" p="4">
			<span>
				Hello! Make sure your board is connected through USB and that it
				is in flash mode! Make sure to select the USB port and not the
				bluetooth port!
			</span>
			{(state === CONNECTION_STATE.DISCONNECTED ||
				state === CONNECTION_STATE.FLASHED) && (
				<button onClick={actionConnect}>Connect</button>
			)}
			{state === CONNECTION_STATE.CONNECTING && (
				<span>Connecting...</span>
			)}
			{state === CONNECTION_STATE.DOWNLOADING && (
				<span>Downloading firmware...</span>
			)}
			{state === CONNECTION_STATE.ERASING && <span>Erasing...</span>}
			{state === CONNECTION_STATE.FLASHING && <span>Flashing...</span>}
			{state === CONNECTION_STATE.FLASHED && <span>Flashed!</span>}
		</chakra.div>
	)
}

export default Page
