import { EventEmitter } from 'events'

// FramePublisher: emits 'frame' events when a new frame arrives
class FramePublisher extends EventEmitter {
  publishFrame(frame: any): void {
    this.emit('frame', frame)
  }

  subscribeFrame(cb: (frame: any) => void): () => void {
    this.on('frame', cb)
    return () => this.off('frame', cb)
  }
}

export const framePublisher = new FramePublisher()
export { FramePublisher }