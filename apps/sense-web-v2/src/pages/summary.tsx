import { useEffect, useMemo, useState } from "react"

import { useRouter } from "next/router"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import SenseLayout from "../components/layout/SenseLayout"
import PdfExportModal, { PdfExportRange } from "../components/processing/PdfExportModal"
import LoadingDots, { LOADING_BUTTON_CLASS } from "../components/processing/LoadingDots"
import { useSessionExport } from "../hooks/useSessionExport"

const Page = () => {
	const router = useRouter();
	const [manifest, setManifest] = useState<any>({});
	const [loading, setLoading] = useState(true);
	const [loadAttempts, setLoadAttempts] = useState(0);
	const [pdfModalOpen, setPdfModalOpen] = useState(false);
	const { csvDownloading, annotatedPdfDownloading, csvExportedRef, pdfExportedRef, convertToCSV, convertToRangePDF } = useSessionExport(manifest)
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
	const interrupted = router.query.interrupted === "1";

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

	const channels = useMemo<string[]>(
		() => (Array.isArray(manifest?.channels) ? manifest.channels.map(String) : []),
		[manifest]
	);
	const channelNames = (manifest?.channelNames && typeof manifest.channelNames === "object")
		? (manifest.channelNames as Record<string, string>)
		: {};
	const segmentSeconds = useMemo<number[]>(() => {
		const segs = Array.isArray(manifest?.segments) ? manifest.segments : [];
		return segs.map((s: any) => {
			const d = (Number(s?.endedAt) - Number(s?.startedAt)) / 1000;
			return Number.isFinite(d) && d > 0 ? d : 0;
		});
	}, [manifest]);

	const handleGeneratePdf = async (range: PdfExportRange) => {
		await convertToRangePDF({
			segment: range.segment,
			startSec: range.startSec,
			endSec: range.endSec,
			channels,
			channelNames
		});
		setPdfModalOpen(false);
	};

	const goToProcessing = async () => {
		const folder = await window.electronAPI?.getCurrentSessionFolder?.();
		if (!folder) {
			alert("Could not locate the session folder for this acquisition.");
			return;
		}
		router.push({ pathname: "/processing", query: { session: folder } });
	};

	return (
		<SenseLayout
			title="Summary"
			returnHref="/live"
			className="flex w-[640px] flex-col items-center justify-center gap-8 py-8 px-8 sm:w-[960px]"
		>
			{interrupted && (
				<div className="text-amber-700 text-center text-base border border-amber-300 rounded p-4 bg-amber-50 max-w-full">
					<b>The connection to the device was lost.</b>
					<div className="mt-2 text-xs">Recording stopped when the device stopped responding. Everything acquired up to that point was saved and is available below.</div>
				</div>
			)}
			{loading ? (
				<span className="text-lg">Loading session data... (Attempt {loadAttempts + 1} of {MAX_ATTEMPTS})</span>
			) : noData ? (
				<div className="text-red-600 text-center text-base border border-red-300 rounded p-4 bg-red-50 max-w-full">
					<b>No valid acquisition data found.</b>
					<div className="mt-2 text-xs">No chunk files with data were found for this session. Please check your acquisition and try again.</div>
				</div>
			) : (
				<>
					<span className="text-lg">End of acquisition!</span>
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
					<div className="flex w-full flex-row justify-center gap-4">
						<TextButton
							size="base"
							className={`flex-1 basis-0 motion-safe:hover:!scale-95 motion-safe:active:!scale-95${csvDownloading ? ` ${LOADING_BUTTON_CLASS}` : ""}`}
							disabled={csvDownloading}
							onClick={convertToCSV}
						>
							<span className="inline-flex items-center justify-center gap-2">
								{csvDownloading && <LoadingDots />}
								{csvDownloading ? "Downloading CSV" : "Download as CSV"}
							</span>
						</TextButton>
						<TextButton
							size="base"
							className={`flex-1 basis-0 motion-safe:hover:!scale-95 motion-safe:active:!scale-95${annotatedPdfDownloading ? ` ${LOADING_BUTTON_CLASS}` : ""}`}
							disabled={annotatedPdfDownloading}
							onClick={() => setPdfModalOpen(true)}
						>
							<span className="inline-flex items-center justify-center gap-2">
								{annotatedPdfDownloading && <LoadingDots />}
								{annotatedPdfDownloading ? "Downloading PDF" : "Download as PDF"}
							</span>
						</TextButton>
						<TextButton
							size="base"
							className="flex-1 basis-0 motion-safe:hover:!scale-95 motion-safe:active:!scale-95"
							onClick={goToProcessing}
						>
							Process Session
						</TextButton>
					</div>

					<PdfExportModal
						open={pdfModalOpen}
						onClose={() => setPdfModalOpen(false)}
						segmentSeconds={segmentSeconds}
						generating={annotatedPdfDownloading}
						onGenerate={handleGeneratePdf}
						title="Export PDF"
						description="Choose the segment and time span to render. Each channel is drawn for the span you pick."
						showAnnotationInfo={false}
						showAnalysisToggle={false}
					/>
				</>
			)}
		</SenseLayout>
	);
}

export default Page
