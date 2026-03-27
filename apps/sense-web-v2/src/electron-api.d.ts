// TypeScript global augmentation for Electron API
export {};

declare global {
  interface Window {
    electronAPI?: {
      sendSample?: (sample: any) => void;
      setBufferSize?: (size: number) => void;
      startAcquisition?: (timestamp: string) => Promise<string>;
      flushSamples?: (finalize?: boolean) => void;
      writeChunk?: (chunk: any) => void;
      finalizeSession?: () => void;
      onChunkWriteComplete?: (callback: (info: { saveTime: number, chunkIndex: number, final: boolean, filename?: string }) => void) => () => void;
      updateSessionManifest?: (manifest: any) => void;
      loadAllChunks?: () => Promise<{ segments: any[][], meta: any }>;
    };
    TESTING_STORAGE?: string;
  }
}
