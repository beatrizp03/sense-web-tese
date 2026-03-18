
// Thin processing adapter: receives processing window from BufferManager and calls SignalProcessor
// Usage: bufferManager.subscribeProcessing(onProcessingWindow)

interface SignalProcessor {
  process: (window: any) => any;
}

type ProcessingWindow = any; // Replace 'any' with actual window type if known
type ReturnResults = (results: any) => void;

function onProcessingWindow(
  window: ProcessingWindow,
  signalProcessor: SignalProcessor,
  returnResults: ReturnResults
): void {
  // Call SignalProcessor with window
  const results = signalProcessor.process(window);
  if (typeof returnResults === 'function') {
    returnResults(results);
  }
}

export { onProcessingWindow }