import { useEffect } from "react"

/**
 * Marks the app as "busy" for as long as `reason` is a non-empty string.
 *
 * Effects while busy:
 *  - Electron main blocks F5 / Ctrl+R / Ctrl+Shift+R keyboard reloads.
 *  - Electron main shows a confirm dialog on any unload (window close,
 *    Next.js dev full-reload, in-app navigation that hits beforeunload).
 *  - The browser `beforeunload` listener gives the renderer a string to
 *    return, which is what triggers the Electron `will-prevent-unload` event.
 *
 * Pass `null` (or an empty string) when the operation finishes.
 */
export function useBusyGuard(reason: string | null | undefined) {
	useEffect(() => {
		const active = typeof reason === "string" && reason.length > 0
		window.electronAPI?.setBusy?.(active ? reason : null)

		if (!active) return

		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault()
			event.returnValue = reason
			return reason
		}
		window.addEventListener("beforeunload", handler)

		return () => {
			window.removeEventListener("beforeunload", handler)
			window.electronAPI?.setBusy?.(null)
		}
	}, [reason])
}
