
// ProcessingSubscriber: real-time processing adapter (scaffolded extension point)
//
// Architectural role
// ------------------
// This module is the connection point between BufferManager's live frame
// stream and any future real-time signal-processing consumer (e.g., live HR
// estimate, signal-quality indicator, in-acquisition artifact flag).
//
// Current status
// --------------
// Scaffolded but not wired up. No live processing consumers are implemented
// in the current scope of the system, which prioritizes post-hoc analysis.
// Post-hoc analysis is handled by AnalysisManager (in the Electron main
// process), which operates on persisted session files after acquisition
// completes — not via this subscriber.
//
// To activate
// -----------
// A future real-time consumer would:
//   1. Implement a SignalProcessor with a process(window) method.
//   2. Subscribe via bufferManager.subscribeProcessing(window =>
//        onProcessingWindow(window, signalProcessor, returnResults)).
//   3. Provide a returnResults callback that forwards computed values to
//      the UI.
//
// The BufferManager's processing buffer is bounded (default 10,000 frames)
// and already maintains a rolling window suitable for online processing.

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