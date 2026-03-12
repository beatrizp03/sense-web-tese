import type { FrameSubscriber } from './FramePublisher'
import { framePublisher } from './FramePublisher'


// UI subscriber registration
function registerUISubscriber(getSamplingRate, updateUI) {
  let graphBuffer = []
  let frameSequence = 0
  let channels = []
  let graphBufferLimit = 10000

  const frameHandler: FrameSubscriber['onFrame'] = frame => {
    if (typeof getSamplingRate === 'function') {
      graphBufferLimit = Math.ceil((getSamplingRate() || 1000) * 5)
    }

    graphBuffer.push([frameSequence, frame])
    if (graphBuffer.length > graphBufferLimit) {
      graphBuffer.shift()
    }
    frameSequence++

    if (channels.length === 0 && frame?.channels) {
      channels = Object.keys(frame.channels).sort()
    }

    if (typeof updateUI === 'function') {
      const minX = Math.max(0, frameSequence - graphBufferLimit)
      updateUI({
        graphBuffer: [...graphBuffer],
        xDomain: [minX, frameSequence],
        channels: [...channels],
        acquisitionStarted: frameSequence > 0
      })
    }
  }

  const resetHandler: FrameSubscriber['onReset'] = () => {
    graphBuffer = []
    frameSequence = 0
    channels = []
    if (typeof updateUI === 'function') {
      updateUI({ graphBuffer: [], xDomain: [0, 0], channels: [], acquisitionStarted: false })
    }
  }

  framePublisher.on('frame', frameHandler)
  framePublisher.on('reset', resetHandler)

  return () => {
    framePublisher.off('frame', frameHandler)
    framePublisher.off('reset', resetHandler)
  }
}

export { registerUISubscriber }