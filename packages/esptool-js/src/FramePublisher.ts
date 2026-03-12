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