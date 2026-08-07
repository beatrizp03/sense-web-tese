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
  private processingBufferLimit: number;
  private storageChunkThreshold: number;
  private chunkIndex = 0;
  private sessionMeta: SessionMeta | null = null;
  private frameSequence = 0;
  private sampleRate = 1000;

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

  private processingBuffer: any[];
  private storageChunkBuffer: any[];

  private processingSubscribers: BufferManagerSubscriber<any[]>[] = [];
  private storageSubscribers: BufferManagerSubscriber<BufferManagerChunkPayload>[] = [];

  setProcessingWindowSize(size: number) {
    this.processingBufferLimit = size;
    this.processingBuffer = [];
  }
  setChunkSize(size: number) {
    this.storageChunkThreshold = size;
  }

  /**
   * Set the sample rate the adaptive threshold is measured against, so the
   * 5-10 second bound in updateChunkThreshold holds at any acquisition rate.
   * Non-destructive by design: unlike startSession() this does not reset the
   * buffers, so it is safe to call while a session is running.
   */
  setSampleRate(rate: number) {
    if (Number.isFinite(rate) && rate > 0) {
      this.sampleRate = rate;
    }
  }

  updateChunkThreshold(saveTime: number) {
    const sampleRate = this.sampleRate;
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
    if (meta?.sampleRate) {
      this.setSampleRate(Number(meta.sampleRate));
    }
  }

  ingest(frame: any | any[]) {
    if (Array.isArray(frame)) {
      frame.forEach(f => this._ingestFrame(f));
    } else {
      this._ingestFrame(frame);
    }
  }

  private _ingestFrame(frame: any) {
    const managedFrame = {
      ...frame,
      __seq: this.frameSequence++
    };

    this.storageChunkBuffer.push(managedFrame);

    if (this.processingSubscribers.length > 0) {
      this.processingBuffer.push(managedFrame);
      if (this.processingBuffer.length > this.processingBufferLimit) {
        this.processingBuffer.shift();
      }
      this.processingSubscribers.forEach(cb => cb([...this.processingBuffer]));
    }

    if (this.storageChunkBuffer.length >= this.storageChunkThreshold) {
      this.flushChunk(false);
    }
  }

  flushChunk(finalize: boolean = false) {
    if (this.storageChunkBuffer.length === 0) {
      return;
    }
    const chunkPayload = {
      frames: [...this.storageChunkBuffer],
      final: finalize,
      meta: finalize ? this.sessionMeta : undefined
    };
    this.storageSubscribers.forEach(cb => cb(chunkPayload));
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

  getChunkIndex() {
    return this.chunkIndex;
  }

  getSessionMeta() {
    return this.sessionMeta;
  }
}

export const bufferManager = new BufferManager();
