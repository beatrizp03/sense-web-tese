"""Generate a synthetic SENSE session for end-to-end testing of the analysis worker.

The output is byte-shape-compatible with the real desktop app:
- session.json carries the same fields produced by SessionManager.createSession
  (channels[], channelSignalKinds, segments, chunks, csvHeader, startedAt, endedAt, ...)
- sample1_chunk0.json is written with the same layout ChunkedDataWriter emits
  (top-level JSON array of frames, each frame pretty-printed with indent=2,
  frames at array indent level 0).

So you can drop the resulting folder straight into the desktop app's
"Import Session Folder" picker and it will load like a real recording.

Usage:
    python make_synthetic_session.py <kind>
    python make_synthetic_session.py <layout>
    python make_synthetic_session.py <kind> --duration 60 --sample-rate 1000

Single kinds: ecg, eda, ppg, emg, rsp, eog, eeg, pcg, acc

Multi-channel layouts (one signal kind per channel, single session):
    set1: AI1=ecg, AI2=eda, AI3=ppg, AI4=emg, AI5=rsp
    set2: AI1=eog, AI2=eeg, AI3=pcg, AI4=acc
    all : AI1=eda, AI2=ppg, AI3=rsp, AI4=ecg, AI5=pcg, AI6=acc (legacy)

Use `set1` + `set2` together to cover every supported signal kind across
just two imports into the desktop app.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import numpy as np
import neurokit2 as nk

SCIENTISST_CHANNEL_SIZES = {
    "AI1": 12, "AI2": 12, "AI3": 12, "AI4": 12, "AI5": 12, "AI6": 12,
}


# The values come from the ScientISST sense.py ADC layer (scientisst/esp_adc/constants.py)
LIN_COEFF_A_SCALE = 65536 
DEFAULT_ADC_CHARS = {
    "adcNum": 1,        # ADC_UNIT_1
    "adcAtten": 3,      # ADC_ATTEN_DB_11
    "adcBitWidth": 3,   # ADC_WIDTH_BIT_12
    "coeffA": LIN_COEFF_A_SCALE,
    "coeffB": 0,
    "vRef": 1100,       # ESP32 eFuse default reference (mV)
}


ADC_PEAK_BY_KIND = {
    "ecg": 1800,
    "emg": 1800,
    "ppg": 1800,
    "rsp": 1700,
    "eda": 1600,
    "eog": 1500,
    "pcg": 1500,
    "acc": 1500,
    "eeg": 60,   
}
DEFAULT_ADC_PEAK = 1500

DEFAULT_SAMPLE_RATE = 1000
DEFAULT_DURATION = 60  #sec
DEFAULT_CHUNK_SIZE = 10000
SUPPORTED_KINDS = ("ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg", "pcg", "acc")


def simulate(kind: str, duration: int, sample_rate: int) -> np.ndarray:
    rng = np.random.default_rng(seed=42)
    if kind == "ecg":
        return np.asarray(
            nk.ecg_simulate(duration=duration, sampling_rate=sample_rate, heart_rate=72, noise=0.05),
            dtype=float,
        )
    if kind == "eda":
        return np.asarray(
            nk.eda_simulate(duration=duration, sampling_rate=sample_rate, scr_number=max(1, duration // 10), noise=0.01),
            dtype=float,
        )
    if kind == "ppg":
        return np.asarray(
            nk.ppg_simulate(duration=duration, sampling_rate=sample_rate, heart_rate=72),
            dtype=float,
        )
    if kind == "emg":
        return np.asarray(
            nk.emg_simulate(duration=duration, sampling_rate=sample_rate, burst_number=max(1, duration // 6)),
            dtype=float,
        )
    if kind == "rsp":
        return np.asarray(
            nk.rsp_simulate(duration=duration, sampling_rate=sample_rate, respiratory_rate=15),
            dtype=float,
        )

    # NeuroKit2 has no dedicated eog/eeg/pcg/acc simulators
    n = duration * sample_rate
    t = np.linspace(0.0, duration, n, endpoint=False)

    if kind == "eog":
        baseline = 0.15 * np.sin(2 * np.pi * 0.2 * t)
        blinks = np.zeros_like(t)
        for blink_t in np.arange(2.0, duration, 4.0):
            mask = (t >= blink_t) & (t < blink_t + 0.25)
            blinks[mask] = 1.2
        return baseline + blinks + 0.02 * rng.standard_normal(n)

    if kind == "eeg":
        alpha = 0.5 * np.sin(2 * np.pi * 10 * t)
        beta = 0.2 * np.sin(2 * np.pi * 20 * t)
        return alpha + beta + 0.1 * rng.standard_normal(n)

    if kind == "pcg":
        period = 60.0 / 72.0  # heart period in seconds
        envelope = np.exp(-(((t % period) - 0.1) ** 2) / 0.001) + \
                   0.6 * np.exp(-(((t % period) - 0.4) ** 2) / 0.002)
        carrier = rng.standard_normal(n)
        return envelope * carrier

    if kind == "acc":
        return np.sin(2 * np.pi * 1.0 * t) + 0.05 * rng.standard_normal(n)

    raise ValueError(f"Unknown signal kind: {kind!r}")


def quantize_to_adc(signal: np.ndarray, kind: str | None = None, bits: int = 12) -> np.ndarray:
    """Quantize a simulator waveform into integer ADC codes [0, 2**bits - 1].

    A real ScientISST acquisition stores raw integer ADC readings per channel
    (see ScientISSTFrame in @scientisst/sense — 0..4095 on a 12-bit input), so a
    physiological waveform in arbitrary units has to go through the ADC step to
    be a faithful stand-in for live-acquired data, and so the analysis worker
    handles synthetic and real sessions identically.
    """
    arr = np.asarray(signal, dtype=float)
    if arr.size == 0:
        return arr.astype(np.int64)
    lo = float(np.min(arr))
    hi = float(np.max(arr))
    max_code = (1 << bits) - 1
    if hi <= lo:
        return np.zeros(arr.shape, dtype=np.int64)
    midpoint = (max_code + 1) // 2
    peak = ADC_PEAK_BY_KIND.get((kind or "").lower(), DEFAULT_ADC_PEAK)
    norm = (arr - lo) / (hi - lo) * 2.0 - 1.0  # min-max -> [-1, 1]
    codes = np.round(midpoint + norm * peak)
    return np.clip(codes, 0, max_code).astype(np.int64)


def write_chunk_slice(
    chunk_path: Path,
    signals: dict[str, np.ndarray],
    start: int,
    end: int,
) -> None:
    """Write one chunk file containing frames [start, end) in the exact layout
    ChunkedDataWriter emits.
    """
    with chunk_path.open("w", encoding="utf-8") as handle:
        handle.write("[\n")
        for i in range(start, end):
            if i > start:
                handle.write(",\n")
            frame = {
                "channels": {ch: int(values[i]) for ch, values in signals.items()},
                "sequence": i,
                "__seq": i,
            }
            handle.write(json.dumps(frame, indent=2))
        handle.write("\n]")


def build_manifest(
    *,
    session_id: str,
    sample_rate: int,
    channels: list[str],
    channel_signal_kinds: dict[str, str],
    started_at_ms: int,
    ended_at_ms: int,
    chunks: list[dict],
) -> dict:
    """Build a session.json byte-for-byte shaped like one the renderer writes for
    a live acquisition.
    """
    iso = (
        datetime.fromtimestamp(started_at_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{started_at_ms % 1000:03d}Z"
    )
    resolution_bits = [SCIENTISST_CHANNEL_SIZES.get(ch, 12) for ch in channels]
    return {
        "sessionId": session_id,
        "startedAt": started_at_ms,
        "deviceType": "sense",
        "sampleRate": sample_rate,
        "channels": channels,
        "channelNames": {ch: ch for ch in channels},
        "adcChars": dict(DEFAULT_ADC_CHARS),
        "firmwareVersion": "",
        "segments": [
            {"index": 1, "startedAt": started_at_ms, "endedAt": ended_at_ms},
        ],
        "chunks": chunks,
        "csvHeader": {
            "Device": "ScientISST Sense",
            "Channels": channels,
            "Sampling rate (Hz)": sample_rate,
            "ISO 8601": iso,
            "Timestamp": started_at_ms,
            "Resolution (bits)": resolution_bits,
        },
        "segment": 1,
        "channelSignalKinds": channel_signal_kinds,
        "timestamp": started_at_ms,
        "endedAt": ended_at_ms,
    }


def write_session(
    *,
    session_dir: Path,
    session_id: str,
    sample_rate: int,
    channels: list[str],
    channel_signal_kinds: dict[str, str],
    signals: dict[str, np.ndarray],
    chunk_size: int,
) -> tuple[int, int]:
    """
    Stream signals to disk as N chunk files plus a session.json manifest.
    """
    session_dir.mkdir(parents=True, exist_ok=True)

    signals = {
        channel: quantize_to_adc(values, channel_signal_kinds.get(channel))
        for channel, values in signals.items()
    }

    n = min(len(s) for s in signals.values())
    chunk_count = max(1, (n + chunk_size - 1) // chunk_size)

    chunks_meta: list[dict] = []
    for chunk_idx in range(chunk_count):
        start = chunk_idx * chunk_size
        end = min(start + chunk_size, n)
        is_final = chunk_idx == chunk_count - 1
        chunk_filename = f"sample1_chunk{chunk_idx}.json"
        chunk_path = session_dir / chunk_filename
        write_chunk_slice(chunk_path, signals, start, end)
        chunks_meta.append({"file": str(chunk_path.resolve()), "segment": 1, "final": is_final})

    started_ms = int(time.time() * 1000)
    ended_ms = started_ms + int(n * 1000 / sample_rate)
    manifest = build_manifest(
        session_id=session_id,
        sample_rate=sample_rate,
        channels=channels,
        channel_signal_kinds=channel_signal_kinds,
        started_at_ms=started_ms,
        ended_at_ms=ended_ms,
        chunks=chunks_meta,
    )
    with (session_dir / "session.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    return chunk_count, n


def make_single_kind_session(
    kind: str, duration: int, sample_rate: int, base_dir: Path, name: str | None,
    chunk_size: int,
) -> Path:
    folder_name = name or f"synthetic-{kind}"
    session_dir = base_dir / folder_name

    signal = simulate(kind, duration, sample_rate)
    n = len(signal)
    flat_zero = np.zeros(n, dtype=float)

    channels = ["AI1", "AI2", "AI3", "AI4", "AI5", "AI6"]
    channel_signals = {
        "AI1": signal,
        "AI2": flat_zero,
        "AI3": flat_zero,
        "AI4": flat_zero,
        "AI5": flat_zero,
        "AI6": flat_zero,
    }

    chunk_count, frame_count = write_session(
        session_dir=session_dir,
        session_id=f"synthetic-{kind}",
        sample_rate=sample_rate,
        channels=channels,
        channel_signal_kinds={"AI1": kind},
        signals=channel_signals,
        chunk_size=chunk_size,
    )
    print(f"  wrote {chunk_count} chunk file(s) covering {frame_count} frames")
    print(f"  session folder: {session_dir}")
    return session_dir


LAYOUTS: dict[str, dict[str, str]] = {
    # Two-session split that covers all 9 supported signal kinds across just
    # two imports. Designed so a tester can drop both folders into the
    # desktop app and verify every analyser end-to-end.
    "set1": {
        "AI1": "ecg",
        "AI2": "eda",
        "AI3": "ppg",
        "AI4": "emg",
        "AI5": "rsp",
    },
    "set2": {
        "AI1": "eog",
        "AI2": "eeg",
        "AI3": "pcg",
        "AI4": "acc",
    },
    # Legacy combined layout (six kinds in one session). Kept for backwards
    # compatibility with earlier docs.
    "all": {
        "AI1": "eda",
        "AI2": "ppg",
        "AI3": "rsp",
        "AI4": "ecg",
        "AI5": "pcg",
        "AI6": "acc",
    },
}


def make_multi_session(
    layout_name: str, duration: int, sample_rate: int, base_dir: Path, name: str | None,
    chunk_size: int,
) -> Path:
    """Pack one signal kind per channel in a single session, per the named layout."""
    layout = LAYOUTS[layout_name]
    folder_name = name or f"synthetic-{layout_name}"
    session_dir = base_dir / folder_name

    all_channels = ["AI1", "AI2", "AI3", "AI4", "AI5", "AI6"]
    sim_per_channel = {ch: simulate(kind, duration, sample_rate) for ch, kind in layout.items()}
    n = min(len(s) for s in sim_per_channel.values())

    flat_zero = np.zeros(n, dtype=float)
    signals: dict[str, np.ndarray] = {}
    for ch in all_channels:
        if ch in sim_per_channel:
            signals[ch] = sim_per_channel[ch][:n]
        else:
            signals[ch] = flat_zero

    chunk_count, frame_count = write_session(
        session_dir=session_dir,
        session_id=f"synthetic-{layout_name}",
        sample_rate=sample_rate,
        channels=all_channels,
        channel_signal_kinds=dict(layout),
        signals=signals,
        chunk_size=chunk_size,
    )
    mapping = ", ".join(f"{ch}={kind}" for ch, kind in layout.items())
    print(f"  layout: {mapping}")
    print(f"  wrote {chunk_count} chunk file(s) covering {frame_count} frames")
    print(f"  session folder: {session_dir}")
    return session_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kind", choices=(*SUPPORTED_KINDS, *LAYOUTS.keys()))
    parser.add_argument("--duration", type=int, default=DEFAULT_DURATION, help=f"Seconds of signal (default: {DEFAULT_DURATION})")
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help=f"Sampling rate in Hz (default: {DEFAULT_SAMPLE_RATE})")
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_CHUNK_SIZE,
        help=f"Frames per chunk file, mirroring BufferManager.storageChunkThreshold (default: {DEFAULT_CHUNK_SIZE})",
    )
    parser.add_argument("--name", default=None, help="Override the session folder name")
    args = parser.parse_args()

    if args.chunk_size <= 0:
        parser.error("--chunk-size must be a positive integer")

    base_dir = Path(__file__).resolve().parent.parent / "data"
    base_dir.mkdir(parents=True, exist_ok=True)

    expected_chunks = max(1, (args.duration * args.sample_rate + args.chunk_size - 1) // args.chunk_size)
    print(
        f"Generating '{args.kind}' session — {args.duration}s @ {args.sample_rate}Hz, "
        f"chunk_size={args.chunk_size} (~{expected_chunks} chunk file(s))"
    )
    if args.kind in LAYOUTS:
        make_multi_session(
            args.kind, args.duration, args.sample_rate, base_dir, args.name, args.chunk_size,
        )
    else:
        make_single_kind_session(
            args.kind, args.duration, args.sample_rate, base_dir, args.name, args.chunk_size,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
