// SignalProcessor: pure signal processing functions/classes
// No UI, IPC, or transport logic

export class SignalProcessor {
  private sampleRate: number;
  private windowSize: number;

  constructor(options?: { sampleRate?: number; windowSize?: number }) {
    this.sampleRate = options?.sampleRate ?? 1000;
    this.windowSize = options?.windowSize ?? 5;
  }

  // Instance method: runs default pipeline (filter, extractFeatures)
  process(window: any[]) {
    // Step 1: filter
    const filtered = SignalProcessor.filter(window, { windowSize: this.windowSize });
    // Step 2: extract features
    const features = SignalProcessor.extractFeatures(filtered);
    // Optionally: add more steps
    return { filtered, features };
  }

  // Example: simple moving average filter
  static filter(window: any[], opts?: { windowSize?: number }) {
    const size = opts?.windowSize || 5;
    return window.map((frame, idx, arr) => {
      const start = Math.max(0, idx - size + 1);
      const slice = arr.slice(start, idx + 1);
      // Example: average channel values
      if (frame.channels) {
        const avgChannels: any = {};
        Object.keys(frame.channels).forEach(ch => {
          avgChannels[ch] = slice.reduce((sum, f) => sum + (f.channels[ch] || 0), 0) / slice.length;
        });
        return { ...frame, avgChannels };
      }
      return frame;
    });
  }

  // Example: feature extraction (mean, std)
  static extractFeatures(window: any[]) {
    // For each channel, compute mean and std
    if (!window.length || !window[0].channels) return {};
    const channels = Object.keys(window[0].channels);
    const features: any = {};
    channels.forEach(ch => {
      const values = window.map(f => f.channels[ch]);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      const std = Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length);
      features[ch] = { mean, std };
    });
    return features;
  }

  // Example: artifact detection (simple threshold)
  static detectArtifacts(window: any[], threshold: number = 1000) {
    if (!window.length || !window[0].channels) return [];
    const channels = Object.keys(window[0].channels);
    return window.map((frame, idx) => {
      const artifacts: any = {};
      channels.forEach(ch => {
        artifacts[ch] = Math.abs(frame.channels[ch]) > threshold;
      });
      return { idx, artifacts };
    });
  }

  // Future: HR, HRV, EDA, etc.
  // static computeHR(window: any[]): number { ... }
  // static computeHRV(window: any[]): number { ... }
  // static computeEDA(window: any[]): number { ... }
}
