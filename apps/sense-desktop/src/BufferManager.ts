// BufferManager: central frame ingestion, buffering, and chunking publisher.
//
// Implements the publisher side of a publisher-subscriber model. 
// Consumers register via subscribeStorage() and
// subscribeProcessing().
//
// Subscribers
// -----------
//   storage:    finalized chunks are forwarded to disk writers
//               (StorageSubscriber). Currently wired and active.
//   processing: rolling windows are forwarded to live signal processors
//               (ProcessingSubscriber). Scaffolded extension point;
//               no live consumers implemented in current scope.
//
// Post-hoc analysis is NOT a subscriber here. It runs as a separate stage
// (AnalysisManager + Python worker) operating on persisted session files
// after acquisition completes. The on-disk session is the boundary between
// the live acquisition path and the post-hoc analysis path.


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
  
  // Config/state
  private processingBufferLimit: number;
  private storageChunkThreshold: number;
  private chunkIndex = 0;
  private sessionMeta: SessionMeta | null = null;
  private frameSequence = 0;

  /**
   * @param options Optional configuration for the BufferManager
   * @param options.uiWindowSize @deprecated UI ring buffer was removed; this option is ignored.
   * @param options.processingWindowSize Maximum frames retained in the rolling
   * processing buffer for live processing subscribers. Has no effect when no
   * consumers are subscribed. Default: 10,000 frames (~10 seconds at 1 kHz).
   * @param options.chunkSize Number of frames per storage chunk before flushing
   * to disk subscribers. Default: 10,000 frames.
   */
  constructor(options?: {
    /** @deprecated UI ring buffer was removed; this option is ignored. */
    uiWindowSize?: number;
    processingWindowSize?: number;
    chunkSize?: number;
  }) {
    this.processingBufferLimit = options?.processingWindowSize ?? 10000;
    this.storageChunkThreshold = options?.chunkSize ?? 10000;
    this.processingBuffer = [];
    this.storageChunkBuffer = [];
  }

  // Buffers: Only processing/storage are needed
  private processingBuffer: any[];
  private storageChunkBuffer: any[];

  // Subscribers
  private processingSubscribers: BufferManagerSubscriber<any[]>[] = [];
  private storageSubscribers: BufferManagerSubscriber<BufferManagerChunkPayload>[] = [];

  setProcessingWindowSize(size: number) {
    this.processingBufferLimit = size;
    this.processingBuffer = [];
  }
  setChunkSize(size: number) {
    this.storageChunkThreshold = size;
  }

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

  private _ingestFrame(frame: any) {
    // Stamp frame with monotonic sequence for x-axis
    const managedFrame = {
      ...frame,
      __seq: this.frameSequence++
    };

    // Storage chunk buffer: linear accumulator (always active).
    this.storageChunkBuffer.push(managedFrame);

    // Processing buffer: bounded rolling window for live processing consumers.
    // Skip maintenance entirely when no consumers are subscribed — the
    // extension point has zero runtime cost while unused.
    if (this.processingSubscribers.length > 0) {
      this.processingBuffer.push(managedFrame);
      if (this.processingBuffer.length > this.processingBufferLimit) {
        this.processingBuffer.shift();
      }
      this.processingSubscribers.forEach(cb => cb([...this.processingBuffer]));
    }

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
