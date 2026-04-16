// BufferManager: central frame ingestion and chunking logic
// Replaces UISubscriber, StorageSubscriber, ProcessingSubscriber, parts of live.tsx, ChunkedDataWriter


// Payload type for storage chunk
export interface BufferManagerChunkPayload {
  frames: any[];
  final: boolean;
  meta?: SessionMeta;
}

interface BufferManagerSubscriber<T> {
  (data: T): void
}

interface SessionMeta {
  [key: string]: any
}

export class BufferManager {
  private finalChunkPromise: Promise<void> | null = null;
  private finalChunkResolver: (() => void) | null = null;
  private finalChunkPending: boolean = false;
    // Add method to update chunk threshold after disk write
    updateChunkThreshold(saveTime: number) {
      const sampleRate = this.sessionMeta?.sampleRate || 1000;
      this.storageChunkThreshold = Math.max(
        sampleRate * 5,
        Math.min(
          sampleRate * (saveTime / 1000 / 0.005),
          sampleRate * 10
        )
      );
      if (process.env.BUFFER_MANAGER_LOGS === '1') {
        console.log(`[BufferManager] Updated chunk threshold: ${this.storageChunkThreshold} (saveTime: ${saveTime}ms)`);
      }
    }
  // Config/state
  // Removed: uiRingBufferLimit
  private processingBufferLimit: number;
  private storageChunkThreshold: number;
  private chunkIndex = 0;
  private sessionMeta: SessionMeta | null = null;
  private frameSequence = 0;

  constructor(options?: {
    uiWindowSize?: number;
    processingWindowSize?: number;
    chunkSize?: number;
  }) {
    // Removed: uiRingBufferLimit
    this.processingBufferLimit = options?.processingWindowSize ?? 10000;
    this.storageChunkThreshold = options?.chunkSize ?? 10000;
    // Removed: uiRingBuffer
    this.processingBuffer = [];
    this.storageChunkBuffer = [];
  }

  // Buffers: Only processing/storage are needed
  private processingBuffer: any[];
  private storageChunkBuffer: any[];

  // Subscribers
  // Removed: uiSubscribers
  private processingSubscribers: BufferManagerSubscriber<any[]>[] = [];
  private storageSubscribers: BufferManagerSubscriber<BufferManagerChunkPayload>[] = [];

  // Removed: setUIWindowSize
  setProcessingWindowSize(size: number) {
    this.processingBufferLimit = size;
    this.processingBuffer = [];
  }
  setChunkSize(size: number) {
    this.storageChunkThreshold = size;
  }

  startSession(meta?: SessionMeta) {
    this.reset();
    this.sessionMeta = meta || null;
    this.frameSequence = 0;
  }

  ingest(frame: any | any[]) {
    if (Array.isArray(frame)) {
      frame.forEach(f => this._ingestFrame(f));
    } else {
      this._ingestFrame(frame);
    }
  }

  // Removed: _pushRingBuffer and _getOrderedBuffer

  private _ingestFrame(frame: any) {
    // Stamp frame with monotonic sequence for x-axis
    const managedFrame = {
      ...frame,
      __seq: this.frameSequence++
    };
    // Removed: UI ring buffer logic
    // Processing buffer: bounded accumulator
    this.processingBuffer.push(managedFrame);
    if (this.processingBuffer.length > this.processingBufferLimit) {
      this.processingBuffer.shift();
    }
    // Storage chunk buffer: linear accumulator
    this.storageChunkBuffer.push(managedFrame);
    // Removed: UI notification
    // Notify processing
    this.processingSubscribers.forEach(cb => cb([...this.processingBuffer]));
    // Chunking logic
    if (this.storageChunkBuffer.length >= this.storageChunkThreshold) {
      this.flushChunk(false);
    }
  }

  flushChunk(finalize: boolean = false) {
    if (this.storageChunkBuffer.length === 0) {
      // Do not increment chunkIndex if no chunk is flushed
      return;
    }
    // Prepare chunk payload
    const chunkPayload = {
      frames: [...this.storageChunkBuffer],
      final: finalize,
      meta: finalize ? this.sessionMeta : undefined
    };
    // Notify storage subscribers with finalized chunk
    this.storageSubscribers.forEach(cb => cb(chunkPayload));
    // Do not adjust chunk threshold here; update after disk write via IPC
    this.storageChunkBuffer = [];
    this.chunkIndex++;
    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`[BufferManager] Saved chunk, static threshold: ${this.storageChunkThreshold}`);
    }
  }

  reset() {
    // Removed: uiRingBuffer reset
    this.processingBuffer = [];
    this.storageChunkBuffer = [];
    this.chunkIndex = 0;
    this.sessionMeta = null;
    this.frameSequence = 0;

    this.finalChunkPromise = null;
    this.finalChunkResolver = null;
    this.finalChunkPending = false;
  }

  /**
   * Stop session and return a Promise that resolves when the final chunk is acknowledged as written.
   * Call notifyFinalChunkWritten() when the final chunk is confirmed written.
   */
  stopSession(): Promise<void> {
    if (this.finalChunkPromise) {
      // Already stopping
      return this.finalChunkPromise;
    }
    if (this.storageChunkBuffer.length === 0) {
      this.reset();
      return Promise.resolve();
    }
    // Set up promise and resolver BEFORE flushing
    this.finalChunkPromise = new Promise<void>((resolve) => {
      this.finalChunkResolver = () => {
        this.reset();
        this.finalChunkPending = false;
        this.finalChunkPromise = null;
        this.finalChunkResolver = null;
        resolve();
      };
    });
    this.finalChunkPending = true;
    this.flushChunk(true);
    return this.finalChunkPromise;
  }

  /**
   * Call this when the final chunk is confirmed written (e.g., from Electron chunk-write-complete event).
   */
  notifyFinalChunkWritten() {
    if (this.finalChunkPending && this.finalChunkResolver) {
      this.finalChunkResolver();
    }
  }

  // Subscription methods
  // Removed: subscribeUI

  subscribeProcessing(cb: BufferManagerSubscriber<any[]>) {
    this.processingSubscribers.push(cb);
    return () => {
      this.processingSubscribers = this.processingSubscribers.filter(sub => sub !== cb);
    };
  }

  subscribeStorage(cb: BufferManagerSubscriber<BufferManagerChunkPayload>) {
    this.storageSubscribers.push(cb);
    return () => {
      this.storageSubscribers = this.storageSubscribers.filter(sub => sub !== cb);
    };
  }

  // Optionally: expose chunkIndex, sessionMeta
  getChunkIndex() {
    return this.chunkIndex;
  }

  getSessionMeta() {
    return this.sessionMeta;
  }
}

export const bufferManager = new BufferManager();
