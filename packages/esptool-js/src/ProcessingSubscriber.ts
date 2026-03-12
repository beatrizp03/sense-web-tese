import type { FrameSubscriber } from './FramePublisher'
import { framePublisher } from './FramePublisher'


function registerProcessingSubscriber(getBufferLimit, processFrame) {
  let processingBuffer = []
  let processingBufferLimit = 10000

  const frameHandler: FrameSubscriber['onFrame'] = frame => {
    if (typeof getBufferLimit === 'function') {
      processingBufferLimit = getBufferLimit() || 5000
    }
    processingBuffer.push(frame)
    if (processingBuffer.length > processingBufferLimit) {
      processingBuffer.shift()
    }
    if (typeof processFrame === 'function') {
      processFrame(frame, [...processingBuffer])
    }
  }

  const resetHandler: FrameSubscriber['onReset'] = () => {
    processingBuffer = []
  }

  framePublisher.on('frame', frameHandler)
  framePublisher.on('reset', resetHandler)

  return () => {
    framePublisher.off('frame', frameHandler)
    framePublisher.off('reset', resetHandler)
  }
}

export { registerProcessingSubscriber }