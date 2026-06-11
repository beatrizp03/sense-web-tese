import { useEffect, useMemo, useState } from "react"

import { useRouter } from "next/router"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import SenseLayout from "../components/layout/SenseLayout"
import { useSessionExport } from "../hooks/useSessionExport"

const Page = () => {
	const router = useRouter();
	const [manifest, setManifest] = useState<any>({});
	const [loading, setLoading] = useState(true);
	const [loadAttempts, setLoadAttempts] = useState(0);
	const { csvDownloading, csvExportedRef, pdfExportedRef, convertToCSV, convertToPDF } = useSessionExport(manifest)
	const MAX_ATTEMPTS = 8;

	useEffect(() => {
		const stopIfPending = () => {
			void window.electronAPI?.stopPerfLoggerIfPending?.({
				csvExported: csvExportedRef.current,
				pdfExported: pdfExportedRef.current
			})
		}

		const handleRouteChangeStart = (url: string) => {
			if (url !== router.asPath) {
				stopIfPending()
			}
		}

		router.events.on("routeChangeStart", handleRouteChangeStart)
		return () => {
			router.events.off("routeChangeStart", handleRouteChangeStart)
		}
	}, [router.asPath, router.events])

	// Sequential retry: wait for session.json to be written before giving up
	useEffect(() => {
		let mounted = true;
		async function tryLoad() {
			if (typeof window === 'undefined' || !window.electronAPI?.loadAllChunks) {
				if (mounted) setLoading(false);
				return;
			}
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				if (!mounted) return;
				setLoadAttempts(attempt);
				try {
					const { meta } = await window.electronAPI.loadAllChunks();
					if (!mounted) return;
					if (meta) {
						setManifest(meta);
						setLoading(false);
						return;
					}
				} catch (e) {
					// session.json may not be written yet, retry
				}
				await new Promise(res => setTimeout(res, 1000));
			}
			if (mounted) setLoading(false);
		}
		tryLoad();
		return () => { mounted = false; };
	}, []);

	const noData = !loading && !manifest?.chunks?.length;

	// Warnings derived from manifest alone — no frame data needed
	const mappingWarnings = useMemo(() => {
		if (!Array.isArray(manifest?.segments) || !Array.isArray(manifest?.chunks)) return [];
		const warnings: string[] = [];
		const chunksBySegment: Record<number, number> = {};
		manifest.chunks.forEach((c: any) => {
			chunksBySegment[c.segment] = (chunksBySegment[c.segment] || 0) + 1;
		});
		manifest.segments.forEach((seg: any, i: number) => {
			if (!chunksBySegment[seg.index]) {
				warnings.push(`Segment ${i + 1}: manifest segment present but no chunk data found.`);
			}
		});
		return warnings;
	}, [manifest]);



		return (
			<SenseLayout
				title="Summary"
				returnHref="/live"
				className="flex w-[480px] flex-col items-center justify-center gap-8 py-8 px-8 sm:w-[640px]"
			>
				{loading ? (
					<span className="text-lg">Loading session data... (Attempt {loadAttempts + 1} of {MAX_ATTEMPTS})</span>
				) : noData ? (
					<div className="text-red-600 text-center text-base border border-red-300 rounded p-4 bg-red-50 max-w-full">
						<b>No valid acquisition data found.</b>
						<div className="mt-2 text-xs">No chunk files with data were found for this session. Please check your acquisition and try again.</div>
					</div>
				) : (
					<>
						<span>End of acquisition!</span>
						{mappingWarnings.length > 0 && (
							<div className="text-red-600 text-xs whitespace-pre-line border border-red-300 rounded p-2 bg-red-50 max-w-full">
								<b>Session Data Warnings:</b>
								<ul className="list-disc ml-4">
									{mappingWarnings.map((w, i) => (
										<li key={i}>{w}</li>
									))}
								</ul>
							</div>
						)}
						<div className="justify-cenPDF flex flex-row gap-4">
							<TextButton
								size="base"
								className="flex-grow"
								disabled={csvDownloading}
								onClick={convertToCSV}
							>
								Download as CSV
							</TextButton>
							<TextButton
								size="base"
								className="flex-grow"
								onClick={convertToPDF}
							>
								Download as PDF
							</TextButton>
						</div>
						<div className="text-xs text-gray-500">
							{csvDownloading && (
								<span>Downloading CSV ...</span>
							)}
						</div>
					</>
				)}
			</SenseLayout>
		);
}

export default Page
