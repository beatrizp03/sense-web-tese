import { EventEmitter } from 'events'

// FramePublisher: emits 'frame' events when a new frame arrives
class FramePublisher extends EventEmitter {
  publishFrame(frame: any): void {
    this.emit('frame', frame)
  }

  publishFrames(frames: any[]): void {
    this.emit('frames', frames)
  }

  subscribeFrame(cb: (frame: any) => void): () => void {
    this.on('frame', cb)
    return () => this.off('frame', cb)
  }

  subscribeFrames(cb: (frames: any[]) => void): () => void {
    this.on('frames', cb)
    return () => this.off('frames', cb)
  }
}

export const framePublisher = new FramePublisher()
export { FramePublisher }