import { EventEmitter } from 'events'

// FramePublisher: emits 'frame' events when a new frame arrives
class FramePublisher extends EventEmitter {
  publishFrame(frame: any) {
    this.emit('frame', frame)
  }
}

export const framePublisher = new FramePublisher()
export { FramePublisher }