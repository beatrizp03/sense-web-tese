// SessionManager: handles session metadata and segment persistence
const { ScientISSTFrame } = require('@scientisst/sense/future');

class SessionManager {
    // --- Manifest Management ---
    static createSession(meta) {
        // meta: { sessionId, startedAt, deviceType, sampleRate, channels, sessionFolder, ... }
        const sessionFolder = meta.sessionFolder;
        this.manifestPath = `${sessionFolder}/session.json`;
        // Main process fallback: no ScientISSTFrame, use 12 as default resolution
        let resolutionBits = [];
        if (meta.deviceType === 'sense' && Array.isArray(meta.channels)) {
            try {
                const { ScientISSTFrame } = require('@scientisst/sense/future');
                for (let j = 0; j < meta.channels.length; j++) {
                    const ch = meta.channels[j];
                    let bits = 12;
                    if (
                        ScientISSTFrame &&
                        ScientISSTFrame.CHANNEL_SIZES &&
                        Object.prototype.hasOwnProperty.call(ScientISSTFrame.CHANNEL_SIZES, ch)
                    ) {
                        bits = ScientISSTFrame.CHANNEL_SIZES[ch];
                    }
                    resolutionBits.push(bits);
                }
            } catch (e) {
                resolutionBits = meta.channels.map(() => 12);
            }
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
            csvHeader: {
                Device: meta.deviceType === "sense"
                    ? "ScientISST Sense"
                    : "ScientISST Maker",
                "Device name": meta.device || "",
                Firmware: meta.firmwareVersion || "",
                Channels: meta.channels || [],
                "Sampling rate (Hz)": meta.sampleRate || 0,
                "ISO 8601": meta.iso8601 || (meta.startedAt ? new Date(meta.startedAt).toISOString() : ''),
                Timestamp: meta.timestamp || meta.startedAt || 0,
                "Resolution (bits)": meta.deviceType === "sense" ? resolutionBits : undefined
            }
        };
        this._persistManifest();
    }
    static updateSessionMeta(patch) {
        if (!this.manifest) return;
        Object.assign(this.manifest, patch);
        // Try to resolve channel sizes if possible
        let resolutionBits = [];
        if (this.manifest.deviceType === 'sense' && Array.isArray(this.manifest.channels)) {
            try {
                const { ScientISSTFrame } = require('@scientisst/sense/future');
                for (let j = 0; j < this.manifest.channels.length; j++) {
                    const ch = this.manifest.channels[j];
                    let bits = 12;
                    if (
                        ScientISSTFrame &&
                        ScientISSTFrame.CHANNEL_SIZES &&
                        Object.prototype.hasOwnProperty.call(ScientISSTFrame.CHANNEL_SIZES, ch)
                    ) {
                        bits = ScientISSTFrame.CHANNEL_SIZES[ch];
                    }
                    resolutionBits.push(bits);
                }
            } catch (e) {
                resolutionBits = this.manifest.channels.map(() => 12);
            }
        }
        if (patch.deviceType || patch.device || patch.channels || patch.sampleRate || patch.iso8601 || patch.timestamp || patch.resolutionBits || patch.resolution) {
            var deviceVal = undefined;
            if (patch.device && typeof patch.device === 'string' && patch.device.trim()) {
                deviceVal = patch.device.trim();
            }
            else if (this.manifest.device && typeof this.manifest.device === 'string' && this.manifest.device.trim()) {
                deviceVal = this.manifest.device.trim();
            }
            else if (patch.deviceType === 'sense' || this.manifest.deviceType === 'sense') {
                deviceVal = 'ScientISST Sense';
            }
            else {
                deviceVal = 'Maker';
            }
            this.manifest.csvHeader = {
                Device: patch.deviceType === "sense"
                    ? "ScientISST Sense"
                    : "Maker",
                "Device name": this.manifest.device || "",
                Firmware: this.manifest.firmwareVersion || "",
                Channels: patch.channels || this.manifest.channels || [],
                "Sampling rate (Hz)": patch.sampleRate || this.manifest.sampleRate || 0,
                "ISO 8601": patch.iso8601 || (patch.startedAt ? new Date(patch.startedAt).toISOString() : (this.manifest.startedAt ? new Date(this.manifest.startedAt).toISOString() : '')),
                Timestamp: patch.timestamp || patch.startedAt || this.manifest.timestamp || this.manifest.startedAt || 0,
                "Resolution (bits)": this.manifest.deviceType === "sense" ? resolutionBits : undefined
            };
        }
        this._persistManifest();
    }
    static registerSegment(segmentInfo) {
        // segmentInfo: { index, startedAt, endedAt }
        if (!this.manifest)
            return;
        this.manifest.segments.push(segmentInfo);
        this._persistManifest();
    }
    static appendChunkRecord(file, segment, final) {
        if (!this.manifest)
            return;
        this.manifest.chunks.push({ file, segment, final });
        this._persistManifest();
    }
    static setChannelNames(names) {
        if (!this.manifest)
            return;
        this.manifest.channelNames = names;
        this._persistManifest();
    }
    static finalizeSession(endedAt) {
        if (!this.manifest)
            return;
        this.manifest.endedAt = endedAt;
        this._persistManifest();
    }
    static loadSession(sessionPath) {
        var _a;
        this.manifestPath = sessionPath;
        if ((_a = window === null || window === void 0 ? void 0 : window.electronAPI) === null || _a === void 0 ? void 0 : _a.readSessionManifest) {
            return window.electronAPI.readSessionManifest(sessionPath)
                .then((manifest) => {
                this.manifest = manifest;
                return manifest;
            });
        }
        else {
            // fallback for web (if needed)
            return fetch(sessionPath)
                .then((res) => res.json())
                .then((manifest) => {
                this.manifest = manifest;
                return manifest;
            });
        }
    }
    static updateSegmentEndedAt(index, endedAt) {
        if (!this.manifest || !Array.isArray(this.manifest.segments))
            return;
        const seg = this.manifest.segments.find(s => s.index === index);
        if (seg) {
            seg.endedAt = endedAt;
            this._persistManifest();
        }
    }
    // --- Internal ---
    static _persistManifest() {
        // Node/Electron main process: write manifest to disk
        if (this.manifestPath && this.manifest) {
            try {
                const fs = require('fs');
                fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
            } catch (e) {
                console.error('[SessionManager] Failed to persist manifest:', e);
            }
        }
    }
}
module.exports = { SessionManager };
// Disk-backed session manifest path (set on create/load)
SessionManager.manifestPath = null;
SessionManager.manifest = null;
