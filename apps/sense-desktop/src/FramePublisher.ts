// Typed subscriber contract for frame events
export interface FrameSubscriber {
  onFrame(frame: any): void
  onReset?(): void
  onSessionStart?(meta?: any): void
  onSessionStop?(): void
}
import { EventEmitter } from 'events'

// FramePublisher: emits 'frame' events when a new frame arrives
class FramePublisher extends EventEmitter {
  publishFrame(frame: any): void {
    this.emit('frame', frame)
  }

  publishFrames(frames: any[]): void {
    frames.forEach(frame => this.publishFrame(frame))
  }

  subscribeFrame(cb: (frame: any) => void): () => void {
    this.on('frame', cb)
    return () => this.off('frame', cb)
  }

  subscribeReset(cb: () => void): () => void {
    this.on('reset', cb)
    return () => this.off('reset', cb)
  }

  subscribeSessionStart(cb: (meta?: any) => void): () => void {
    this.on('session-start', cb)
    return () => this.off('session-start', cb)
  }

  subscribeSessionStop(cb: () => void): () => void {
    this.on('session-stop', cb)
    return () => this.off('session-stop', cb)
  }

  reset(): void {
    this.emit('reset')
  }

  startSession(meta?: any): void {
    this.emit('session-start', meta)
  }

  stopSession(): void {
    this.emit('session-stop')
  }
}

export const framePublisher = new FramePublisher()
export { FramePublisher }