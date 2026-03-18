// Thin UI buffer adapter: receives prepared UI buffer and adapts for chart state
// Usage: bufferManager.subscribeUI(onUIBufferUpdated)

function onUIBufferUpdated(bufferWindow: any[], updateUI: (payload: any) => void) {
  // Use monotonic __seq for x-axis
  const chartData = bufferWindow.map((frame: any) => [
    frame.__seq,
    frame
  ]);
  const xDomain: [number, number] =
    chartData.length > 0
      ? [chartData[0][0], chartData[chartData.length - 1][0]]
      : [0, 0];

  // Extract channels from latest frame if not present
  let channels: string[] = [];
  if (chartData.length > 0) {
    const lastFrame = chartData[chartData.length - 1][1];
    if (lastFrame && lastFrame.channels) {
      channels = Object.keys(lastFrame.channels).sort();
    }
  }

  if (typeof updateUI === "function") {
    updateUI({
      graphBuffer: chartData,
      xDomain,
      channels,
      acquisitionStarted: chartData.length > 0
    });
  }
}

// No buffering, no framePublisher subscription
export { onUIBufferUpdated }