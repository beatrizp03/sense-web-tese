// SessionManager: handles session metadata and segment persistence

export class SessionManager {
  // Removed: saveSegment (no longer needed after chunked file refactor)

  static saveChannels(channels: string[]) {
    if (channels.length > 0) {
      localStorage.setItem("aq_channels", JSON.stringify(channels));
    }
  }

  static saveSampleRate(sampleRate: number) {
    localStorage.setItem("aq_sampleRate", JSON.stringify(sampleRate));
  }

  static saveDeviceType(deviceType: string) {
    localStorage.setItem("aq_deviceType", deviceType);
  }

  static clearSessionLocalState() {
    for (const key in localStorage) {
      if (key.startsWith("aq_")) {
        localStorage.removeItem(key);
      }
    }
  }

  static saveSegmentFrames(segment: number, frames: any[]) {
    if (!frames || frames.length === 0) return;

    const serialized = frames
      .map(frame => {
        const f =
          Array.isArray(frame) &&
          frame.length === 2 &&
          frame[1]?.channels
            ? frame[1]
            : frame;

        return f?.serialize ? f.serialize() : JSON.stringify(f);
      })
      .join("");

    localStorage.setItem(`aq_seg${segment}`, serialized);
    localStorage.setItem(`aq_seg${segment}time`, JSON.stringify(Date.now()));
  }

  static saveSegmentCount(count: number) {
    localStorage.setItem("aq_segments", JSON.stringify(count));
  }
}
