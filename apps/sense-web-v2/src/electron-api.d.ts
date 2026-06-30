// TypeScript global augmentation for Electron API
export {};

type SessionSettingsSnapshot = {
  id: string;
  label: string;
  savedAt: number;
  settings: Record<string, unknown>;
};

declare global {
  interface Window {
    electronAPI?: {
      listSerialPorts?: () => Promise<any[]>;
      requestPort?: () => Promise<string>;
      writeSerialPort?: (path: string, data: any) => Promise<void>;
      onSerialData?: (path: string, cb: (data: Uint8Array) => void) => () => void;
      startAcquisition?: (startTime: string) => Promise<string>;
      stopAcquisition?: () => void;
      finalizeSession?: (endedAt: number) => Promise<void>;
      flushChunk?: (final?: boolean) => void;
      setBufferSize?: (size: number) => void;
      sendFrame?: (frame: any) => void;
      onChunkWriteComplete?: (callback: (info: { saveTime: number, chunkIndex: number, final: boolean, filename?: string }) => void) => () => void;
      updateSessionManifest?: (manifest: any) => void;
      createSession?: (meta: any) => Promise<void>;
      registerSegment?: (segmentInfo: any) => Promise<void>;
      updateSessionMeta?: (patch: any) => Promise<void>;
      updateSegmentEndedAt?: (index: number, endedAt: number) => Promise<void>;
      setChannelNames?: (names: Record<string, string>) => Promise<void>;
      readChunkFile?: (filePath: string) => Promise<any>;
      loadAllChunks?: () => Promise<{ meta: any }>;
      getCurrentSessionFolder?: () => Promise<string | null>;
      loadPreviewFrames?: (sampleNum: number, frameCount: number) => Promise<any[]>;
      decimateSession?: (
        sessionFolder: string,
        targetPoints?: number,
        segment?: number
      ) => Promise<{
        sampleRate: number;
        totalSamples: number;
        series: Record<string, [number, number][]>;
      }>;
      selectAnalysisSessionFolder?: () => Promise<string | null>;
      openSerialPort?: (path: string, options?: any) => Promise<void>;
      readSerialPort?: (path: string, bytes: number, timeout: number) => Promise<Uint8Array>;
      closeSerialPort?: (path: string) => Promise<void>;
      clearRingBuffer?: () => void;
      readSessionManifest?: (sessionPath: string) => Promise<any>;
      readSessionAnnotations?: (sessionFolder: string) => Promise<any>;
      writeSessionAnnotations?: (sessionFolder: string, data: any) => Promise<{ ok: boolean }>;
      readSessionLabels?: (sessionFolder: string) => Promise<any>;
      writeSessionLabels?: (sessionFolder: string, data: any) => Promise<{ ok: boolean }>;
      exportAnnotationsCsv?: (sessionFolder: string) => Promise<{ ok: boolean; path?: string; count?: number; canceled?: boolean; error?: string }>;
      runPostHocAnalysis?: (payload?: { sessionFolder?: string; pythonExecutable?: string; outputDir?: string; outputSubdir?: string; signalKinds?: Record<string, string>; signalAxes?: Record<string, string>; outlierRemoval?: boolean; edaMethod?: "auto" | "neurokit" | "biosppy"; excludedChannels?: string[]; signalKindLibraries?: Record<string, "neurokit" | "biosppy">; emgWindowMs?: number; emgWindowStepMs?: number; hrvWindowSec?: number; hrvWindowStepSec?: number; range?: { startSec: number; endSec: number }; segment?: number }) => Promise<any>;
      cancelPostHocAnalysis?: (payload?: { sessionFolder?: string; reason?: string }) => Promise<{ cancelled: boolean }>;
      onAnalysisProgress?: (callback: (data: { percentage: number; signalKind: string; startTime: number }) => void) => () => void;
      readPostHocAnalysisResult?: (sessionFolderPath: string, subdir?: string) => Promise<any>;
      selectAnalysisResultFolder?: () => Promise<{ folderPath: string; folderName: string; result: any; error?: string } | null>;
      openExternalPath?: (path: string) => Promise<void>;
      acquisitionError?: (sessionPath: string) => Promise<void>;
      onShowCloseWarning?: (callback: () => void) => () => void;
      confirmClose?: (shouldClose: boolean) => void;
      resetSession?: () => void;
      logPerfEvent?: (name: string, durationMs?: number) => void;
      logAnnotationEvent?: (payload: { sessionFolder: string; action: string; durationMs?: number; annotationCount?: number; detail?: unknown }) => void;
      stopPerfLoggerIfPending?: (status: { csvExported?: boolean; pdfExported?: boolean }) => Promise<{ stopped: boolean }>;
      loadSessionSettingsHistory?: () => Promise<SessionSettingsSnapshot[]>;
      saveSessionSettingsSnapshot?: (snapshot: SessionSettingsSnapshot) => Promise<SessionSettingsSnapshot[]>;
      clearSessionSettingsHistory?: () => Promise<void>;
      setBusy?: (reason: string | null) => void;
    };
  }
}
