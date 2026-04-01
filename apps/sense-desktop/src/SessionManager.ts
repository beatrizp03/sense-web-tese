// SessionManager: handles session metadata and segment persistence

export class SessionManager {
  // Disk-backed session manifest path (set on create/load)
  static manifestPath = null;
  static manifest = null;

  // --- Manifest Management ---
  static createSession(meta) {
    // meta: { sessionId, startedAt, deviceType, sampleRate, channels, sessionFolder, ... }
    const sessionFolder = meta.sessionFolder;
    this.manifestPath = `${sessionFolder}/session.json`;
    this.manifest = {
      sessionId: meta.sessionId,
      startedAt: meta.startedAt,
      deviceType: meta.deviceType,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      channelNames: meta.channelNames || {},
      adcChars: meta.adcChars || {},
      segments: [],
      chunks: [],
      // CSV-style header for graph/data reconstruction
      csvHeader: {
        Device: meta.deviceType || meta.device || '',
        Channels: meta.channels || [],
        "Sampling rate (Hz)": meta.sampleRate || 0,
        "ISO 8601": meta.iso8601 || (meta.startedAt ? new Date(meta.startedAt).toISOString() : ''),
        Timestamp: meta.timestamp || meta.startedAt || 0,
        "Resolution (bits)": meta.resolutionBits || meta.resolution || [],
      }
    };
    this._persistManifest();
    // Removed localStorage logic for TESTING flag; persistence is now only via chunk files.
  }

  static updateSessionMeta(patch) {
    if (!this.manifest) return;
    Object.assign(this.manifest, patch);
    // If patch contains any csvHeader-relevant fields, update csvHeader as well
    if (patch.deviceType || patch.device || patch.channels || patch.sampleRate || patch.iso8601 || patch.timestamp || patch.resolutionBits || patch.resolution) {
      this.manifest.csvHeader = {
        Device: patch.deviceType || patch.device || this.manifest.deviceType || '',
        Channels: patch.channels || this.manifest.channels || [],
        "Sampling rate (Hz)": patch.sampleRate || this.manifest.sampleRate || 0,
        "ISO 8601": patch.iso8601 || (patch.startedAt ? new Date(patch.startedAt).toISOString() : (this.manifest.startedAt ? new Date(this.manifest.startedAt).toISOString() : '')),
        Timestamp: patch.timestamp || patch.startedAt || this.manifest.timestamp || this.manifest.startedAt || 0,
        "Resolution (bits)": patch.resolutionBits || patch.resolution || this.manifest.resolutionBits || this.manifest.resolution || [],
      };
    }
    this._persistManifest();
    // Removed localStorage logic for TESTING flag; persistence is now only via chunk files.
  }

  static registerSegment(segmentInfo) {
    // segmentInfo: { index, startedAt, endedAt }
    if (!this.manifest) return;
    this.manifest.segments.push(segmentInfo);
    this._persistManifest();
  }

  static appendChunkRecord(file, segment, final) {
    if (!this.manifest) return;
    this.manifest.chunks.push({ file, segment, final });
    this._persistManifest();
  }

  static setChannelNames(names) {
    if (!this.manifest) return;
    this.manifest.channelNames = names;
    this._persistManifest();
  }

  static finalizeSession(endedAt) {
    if (!this.manifest) return;
    this.manifest.endedAt = endedAt;
    this._persistManifest();
  }

  static loadSession(sessionPath) {
    // Loads manifest from disk (renderer: fetch, Electron: not implemented)
    this.manifestPath = sessionPath;
    return fetch(sessionPath)
      .then((res) => res.json())
      .then((manifest) => {
        this.manifest = manifest;
        return manifest;
      });
  }

  static updateSegmentEndedAt(index, endedAt) {
    if (!this.manifest || !Array.isArray(this.manifest.segments)) return;
    const seg = this.manifest.segments.find(s => s.index === index);
    if (seg) {
      seg.endedAt = endedAt;
      this._persistManifest();
    }
  }
  
  // --- Internal ---
  static _persistManifest() {
    if (window?.electronAPI?.updateSessionManifest && this.manifest) {
      window.electronAPI.updateSessionManifest(this.manifest);
    }
  }
}
