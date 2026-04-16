// TypeScript global augmentation for Electron API
export {};

declare global {
  interface Window {
    electronAPI?: {
      listSerialPorts?: () => Promise<any[]>;
      requestPort?: () => Promise<string>;
      writeSerialPort?: (path: string, data: any) => Promise<void>;
      onSerialData?: (path: string, cb: (data: Uint8Array) => void) => () => void;
      startAcquisition?: (startTime: string) => Promise<string>;
      stopAcquisition?: () => void;
      finalizeSession?: () => void;
      flushChunk?: (final?: boolean) => void;
      setBufferSize?: (size: number) => void;
      sendFrame?: (frame: any) => void;
      onChunkWriteComplete?: (callback: (info: { saveTime: number, chunkIndex: number, final: boolean, filename?: string }) => void) => () => void;
      updateSessionManifest?: (manifest: any) => void;
      loadAllChunks?: () => Promise<{ segments: any[][], meta: any }>;
      openSerialPort?: (path: string, options?: any) => Promise<void>;
      readSerialPort?: (path: string, bytes: number, timeout: number) => Promise<Uint8Array>;
      closeSerialPort?: (path: string) => Promise<void>;
      clearRingBuffer?: () => void;
      readSessionManifest?: (sessionPath: string) => Promise<any>;
      acquisitionError?: (sessionPath: string) => Promise<void>;
      onShowCloseWarning?: (callback: () => void) => () => void;
      confirmClose?: (shouldClose: boolean) => void;
    };
  }
}
