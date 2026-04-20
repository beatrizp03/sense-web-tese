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
      loadPreviewFrames?: (sampleNum: number, frameCount: number) => Promise<any[]>;
      openSerialPort?: (path: string, options?: any) => Promise<void>;
      readSerialPort?: (path: string, bytes: number, timeout: number) => Promise<Uint8Array>;
      closeSerialPort?: (path: string) => Promise<void>;
      clearRingBuffer?: () => void;
      readSessionManifest?: (sessionPath: string) => Promise<any>;
      acquisitionError?: (sessionPath: string) => Promise<void>;
      onShowCloseWarning?: (callback: () => void) => () => void;
      confirmClose?: (shouldClose: boolean) => void;
      resetSession?: () => void;
      logPerfEvent?: (name: string, durationMs?: number) => void;
      loadSessionSettingsHistory?: () => Promise<SessionSettingsSnapshot[]>;
      saveSessionSettingsSnapshot?: (snapshot: SessionSettingsSnapshot) => Promise<SessionSettingsSnapshot[]>;
    };
  }
}
