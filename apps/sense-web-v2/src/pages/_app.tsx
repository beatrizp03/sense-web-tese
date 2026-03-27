import React, { useEffect } from "react"

import type { AppProps } from "next/app"

import { ChakraProvider } from "@chakra-ui/react"
import { config } from "@fortawesome/fontawesome-svg-core"
import "@fortawesome/fontawesome-svg-core/styles.css"
import { Lexend } from "@next/font/google"
import localFont from "@next/font/local"
import { NoSSR, defaultScientISSTTheme } from "@scientisst/chakra-ui"

import "../styles/global.css"
import '../electron-api.d.ts';

config.autoAddCss = false

const lexend = Lexend({
	weight: ["400", "500", "600", "700", "800"],
	subsets: ["latin"]
})

const imagine = localFont({
	src: "./imagine.ttf"
})


export default function MyApp({ Component, pageProps }: AppProps) {
	useEffect(() => {
		const version = localStorage.getItem("version")

		if (version !== "2.8.0") {
			localStorage.clear()
			localStorage.setItem("version", "2.7.0")
		}

		// when running in Electron we always expose the bridge on
		// `navigator.serial`. this forces the desktop app to use the native
		// transport and lets us run our custom COM‑port chooser/auto‑scan.
		if (
			typeof window !== "undefined" &&
			typeof (window as any).electronAPI !== "undefined"
		) {
			const api = (window as any).electronAPI
			const serialObj = {
				requestPort: api.requestPort,
				getPorts: api.listSerialPorts
			}
			try {
				// navigator.serial is sometimes a getter-only property; using
				// defineProperty lets us replace it regardless.
				Object.defineProperty(navigator, "serial", {
					configurable: true,
					enumerable: true,
					writable: true,
					value: serialObj
				})
			} catch (e) {
				// fallback if defineProperty fails for any reason
				;(navigator as any).serial = serialObj
			}
		}
	}, [])

	return (
		<NoSSR>
			<ChakraProvider theme={defaultScientISSTTheme}>
				<style jsx global>{`
					:root {
						--font-lexend: ${lexend.style.fontFamily};
						--font-imagine: ${imagine.style.fontFamily};
					}
				`}</style>
				<Component {...pageProps} />
			</ChakraProvider>
		</NoSSR>
	)
}
