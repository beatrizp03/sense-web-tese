// Thin storage chunk adapter: receives finalized chunks and sends to Electron main process via IPC
// Usage: bufferManager.subscribeStorage(onChunkReady)

function onChunkReady(chunk: any, sendToDisk: (chunk: any) => void) {
  // Send chunk to Electron main process through preload/IPC
  if (typeof sendToDisk === 'function') {
    sendToDisk(chunk);
  }
}

function onSessionStart(meta: any, notifySessionStart: (meta: any) => void) {
  if (typeof notifySessionStart === 'function') {
    notifySessionStart(meta);
  }
}

function onSessionStop(finalChunk: any, notifySessionStop: (finalChunk: any) => void) {
  if (typeof notifySessionStop === 'function') {
    notifySessionStop(finalChunk);
  }
}

export { onChunkReady, onSessionStart, onSessionStop }