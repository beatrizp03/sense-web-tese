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
      // Notify Electron preload to update buffer size
      if (typeof window !== 'undefined' && window.electronAPI?.setBufferSize) {
        window.electronAPI.setBufferSize(this.storageChunkThreshold);
      }
      if (process.env.BUFFER_MANAGER_LOGS === '1') {
        console.log(`[BufferManager] Updated chunk threshold: ${this.storageChunkThreshold} (saveTime: ${saveTime}ms)`);
      }
    }
  // Config/state
  private uiRingBufferLimit: number;
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
    this.uiRingBufferLimit = options?.uiWindowSize ?? 10000;
    this.processingBufferLimit = options?.processingWindowSize ?? 10000;
    this.storageChunkThreshold = options?.chunkSize ?? 10000;
    this.uiRingBuffer = { data: [], head: 0, size: this.uiRingBufferLimit };
    this.processingBuffer = [];
    this.storageChunkBuffer = [];
  }

  // Buffers: UI is ring buffer, processing/storage are linear accumulators
  private uiRingBuffer: { data: any[]; head: number; size: number };
  private processingBuffer: any[];
  private storageChunkBuffer: any[];

  // Subscribers
  private uiSubscribers: BufferManagerSubscriber<any[]>[] = [];
  private processingSubscribers: BufferManagerSubscriber<any[]>[] = [];
  private storageSubscribers: BufferManagerSubscriber<BufferManagerChunkPayload>[] = [];

  setUIWindowSize(size: number) {
    this.uiRingBufferLimit = size;
    this.uiRingBuffer.size = size;
    this.uiRingBuffer.data = [];
    this.uiRingBuffer.head = 0;
  }
  setProcessingWindowSize(size: number) {
    this.processingBufferLimit = size;
    this.processingBuffer = [];
  }
  setChunkSize(size: number) {
    this.storageChunkThreshold = size;
    this.storageChunkBuffer = [];
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

  // True circular buffer logic
  private _pushRingBuffer(bufferObj: { data: any[]; head: number; size: number }, item: any) {
    if (bufferObj.data.length < bufferObj.size) {
      bufferObj.data.push(item);
    } else {
      bufferObj.data[bufferObj.head] = item;
      bufferObj.head = (bufferObj.head + 1) % bufferObj.size;
    }
  }

  private _getOrderedBuffer(bufferObj: { data: any[]; head: number; size: number }) {
    if (bufferObj.data.length < bufferObj.size) {
      return [...bufferObj.data];
    }
    // Return oldest to newest
    return bufferObj.data.slice(bufferObj.head).concat(bufferObj.data.slice(0, bufferObj.head));
  }

  private _ingestFrame(frame: any) {
    // Stamp frame with monotonic sequence for x-axis
    const managedFrame = {
      ...frame,
      __seq: this.frameSequence++
    };
    // UI ring buffer
    this._pushRingBuffer(this.uiRingBuffer, managedFrame);
    // Processing buffer: bounded accumulator
    this.processingBuffer.push(managedFrame);
    if (this.processingBuffer.length > this.processingBufferLimit) {
      this.processingBuffer.shift();
    }
    // Storage chunk buffer: linear accumulator
    this.storageChunkBuffer.push(managedFrame);
    // Notify UI
    this.uiSubscribers.forEach(cb => cb(this._getOrderedBuffer(this.uiRingBuffer)));
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
    this.uiRingBuffer.data = [];
    this.uiRingBuffer.head = 0;
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
  subscribeUI(cb: BufferManagerSubscriber<any[]>) {
    this.uiSubscribers.push(cb);
    return () => {
      this.uiSubscribers = this.uiSubscribers.filter(sub => sub !== cb);
    };
  }

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
