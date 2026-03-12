import type { FrameSubscriber } from "./FramePublisher"
import { framePublisher } from "./FramePublisher"

function registerStorageSubscriber(getBufferThreshold, saveData) {
  let storageBuffer: any[] = []
  let storageBufferThreshold = 10000

  const frameHandler: FrameSubscriber["onFrame"] = frame => {
    if (typeof getBufferThreshold === "function") {
      storageBufferThreshold = getBufferThreshold() || 10000
    }

    storageBuffer.push(frame)

    if (storageBuffer.length >= storageBufferThreshold) {
      flushBuffer()
    }
  }

  function flushBuffer() {
    if (storageBuffer.length === 0) return

    if (typeof saveData === "function") {
      saveData([...storageBuffer])
    }

    storageBuffer = []
  }

  const resetHandler: FrameSubscriber["onReset"] = () => {
    storageBuffer = []
  }

  const sessionStartHandler: FrameSubscriber["onSessionStart"] = () => {
    storageBuffer = []
  }

  const sessionStopHandler: FrameSubscriber["onSessionStop"] = () => {
    flushBuffer()
    storageBuffer = []
  }

  framePublisher.on("session-start", sessionStartHandler)
  framePublisher.on("frame", frameHandler)
  framePublisher.on("reset", resetHandler)
  framePublisher.on("session-stop", sessionStopHandler)

  return () => {
    framePublisher.off("session-start", sessionStartHandler)
    framePublisher.off("frame", frameHandler)
    framePublisher.off("reset", resetHandler)
    framePublisher.off("session-stop", sessionStopHandler)
  }
}

export { registerStorageSubscriber }