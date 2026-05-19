// SessionManager: handles session metadata and segment persistence
import { ScientISSTFrame } from "@scientisst/sense/future"

export class SessionManager {
  // Disk-backed session manifest path (set on create/load)
  static manifestPath: string | null = null;
  static manifest: any = null;

  // --- Manifest Management ---
  static createSession(meta: any) {
    // meta: { sessionId, startedAt, deviceType, sampleRate, channels, sessionFolder, ... }
    const sessionFolder = meta.sessionFolder;
    this.manifestPath = `${sessionFolder}/session.json`;
    
    const resolutionBits = [];
    for (let j = 0; j < meta.channels.length; j++) {
      resolutionBits.push((ScientISSTFrame as any).CHANNEL_SIZES[meta.channels[j]]);
    }
    
    this.manifest = {
      sessionId: meta.sessionId,
      startedAt: meta.startedAt,
      device: meta.device || meta.port || meta.devicePath || "",
      deviceType: meta.deviceType,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      channelNames: meta.channelNames || {},
      channelSignalKinds: meta.channelSignalKinds || {},
      channelSignalAxes: meta.channelSignalAxes || {},
      adcChars: meta.adcChars || {},
      firmwareVersion: meta.firmwareVersion || "",
      segments: [],
      chunks: [],
      // CSV-style header for graph/data reconstruction
      csvHeader: {
        Device:
          meta.deviceType === "sense"
            ? "ScientISST Sense"
            : "ScientISST Maker",
        Channels: meta.channels || [],
        "Sampling rate (Hz)": meta.sampleRate || 0,
        "ISO 8601": meta.iso8601 || (meta.startedAt ? new Date(meta.startedAt).toISOString() : ''),
        Timestamp: meta.timestamp || meta.startedAt || 0,
        "Resolution (bits)": meta.deviceType === "sense" ? resolutionBits : undefined
      }
    };
    this._persistManifest();
    // Removed localStorage logic for TESTING flag; persistence is now only via chunk files.
  }

  static updateSessionMeta(patch: any) {
    if (!this.manifest) return;
    const manifest = this.manifest as any;
    Object.assign(manifest, patch);
    const resolutionBits = [];
    for (let j = 0; j < manifest.channels.length; j++) {
      resolutionBits.push((ScientISSTFrame as any).CHANNEL_SIZES[manifest.channels[j]]);
    }
    
    // If patch contains any csvHeader-relevant fields, update csvHeader as well
    if (patch.deviceType || patch.device || patch.channels || patch.sampleRate || patch.iso8601 || patch.timestamp || patch.resolutionBits || patch.resolution) {
      // prefer explicit device name (e.g. serial/bluetooth port) when available
      let deviceVal: string | undefined = undefined;
      if (patch.device && typeof patch.device === "string" && patch.device.trim()) {
        deviceVal = patch.device.trim();
      } else if (manifest.device && typeof manifest.device === "string" && manifest.device.trim()) {
        deviceVal = manifest.device.trim();
      } else if (patch.deviceType === "sense" || manifest.deviceType === "sense") {
        deviceVal = "ScientISST Sense";
      } else {
        deviceVal = "ScientISST Maker";
      }
      manifest.csvHeader = {
        Device: patch.deviceType === "sense"
						? "ScientISST Sense"
						: "Maker",
        Channels: patch.channels || manifest.channels || [],
        "Sampling rate (Hz)": patch.sampleRate || manifest.sampleRate || 0,
        "ISO 8601": patch.iso8601 || (patch.startedAt ? new Date(patch.startedAt).toISOString() : (manifest.startedAt ? new Date(manifest.startedAt).toISOString() : '')),
        Timestamp: patch.timestamp || patch.startedAt || manifest.timestamp || manifest.startedAt || 0,
        "Resolution (bits)": manifest.deviceType === "sense" ? resolutionBits : undefined
      };
    }
    this._persistManifest();
    // Removed localStorage logic for TESTING flag; persistence is now only via chunk files.
  }

  static registerSegment(segmentInfo: any) {
    // segmentInfo: { index, startedAt, endedAt }
    if (!this.manifest) return;
    this.manifest.segments.push(segmentInfo);
    this._persistManifest();
  }

  static appendChunkRecord(file: any, segment: any, final: any) {
    if (!this.manifest) return;
    this.manifest.chunks.push({ file, segment, final });
    this._persistManifest();
  }

  static setChannelNames(names: any) {
    if (!this.manifest) return;
    this.manifest.channelNames = names;
    this._persistManifest();
  }

  static finalizeSession(endedAt: any) {
    if (!this.manifest) return;
    this.manifest.endedAt = endedAt;
    this._persistManifest();
  }

  static loadSession(sessionPath: any) {
    this.manifestPath = sessionPath;
    if ((window as any)?.electronAPI?.readSessionManifest) {
      return (window as any).electronAPI.readSessionManifest(sessionPath)
        .then((manifest: any) => {
          this.manifest = manifest;
          return manifest;
        });
    } else {
      // fallback for web (if needed)
      return fetch(sessionPath)
        .then((res) => res.json())
        .then((manifest) => {
          this.manifest = manifest;
          return manifest;
        });
    }
  }

  static updateSegmentEndedAt(index: any, endedAt: any) {
    if (!this.manifest || !Array.isArray(this.manifest.segments)) return;
    const seg = this.manifest.segments.find((s: any) => s.index === index);
    if (seg) {
      seg.endedAt = endedAt;
      this._persistManifest();
    }
  }

  // --- Internal ---
  static _persistManifest() {
    if ((window as any)?.electronAPI?.updateSessionManifest && this.manifest) {
      (window as any).electronAPI.updateSessionManifest(this.manifest);
    }
  }
}
