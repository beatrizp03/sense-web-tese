#!/usr/bin/env python3
"""Post-hoc analysis worker for SENSE Desktop.

This script is intentionally self-contained so Electron can spawn one process
per analysis job and collect a single JSON result.

Input:
  --session-folder  Folder that contains session.json and chunk files
  --output-folder   Folder where analysis artifacts should be written

Output:
  Writes analysis-result.json and per-channel CSV files under output-folder,
  then prints the JSON result to stdout.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is a runtime dependency
    np = None

try:
    import neurokit2 as nk
except Exception:  # pragma: no cover - optional until dependency is installed
    nk = None

try:
    from biosppy.signals import ecg as biosppy_ecg
    from biosppy.signals import eda as biosppy_eda
    from biosppy.signals import ppg as biosppy_ppg
    from biosppy.signals import emg as biosppy_emg
    from biosppy.signals import rsp as biosppy_rsp
except Exception:  # pragma: no cover - optional until dependency is installed
    biosppy_ecg = None
    biosppy_eda = None
    biosppy_ppg = None
    biosppy_emg = None
    biosppy_rsp = None


RESERVED_FRAME_KEYS = {
    "__seq",
    "timestamp",
    "time",
    "deviceTime",
    "sample",
    "samples",
    "channels",
    "meta",
}

CHUNK_FILENAME_RE = re.compile(r"^sample(?P<sample>\d+)_chunk(?P<chunk>\d+)\.json$", re.IGNORECASE)
SUPPORTED_SIGNAL_KINDS = {"ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg", "pcg", "acc"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run post-hoc signal analysis for a SENSE session")
    parser.add_argument("--session-folder", required=True, help="Path to a session folder")
    parser.add_argument("--output-folder", required=True, help="Path to the analysis output folder")
    return parser.parse_args()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        if isinstance(value, bool):
            return float(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return None
            return float(value)
        converted = float(value)
        if math.isnan(converted) or math.isinf(converted):
            return None
        return converted
    except Exception:
        return None


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_session_manifest(session_folder: Path) -> Dict[str, Any]:
    manifest_path = session_folder / "session.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing manifest: {manifest_path}")
    manifest = load_json(manifest_path)
    if not isinstance(manifest, dict):
        raise ValueError("Session manifest must be a JSON object")
    return manifest


def load_chunk_frames(chunk_path: Path) -> List[Dict[str, Any]]:
    data = load_json(chunk_path)
    if isinstance(data, dict) and isinstance(data.get("frames"), list):
        frames = data["frames"]
    elif isinstance(data, list):
        frames = data
    else:
        frames = []

    normalized = []
    for frame in frames:
        if isinstance(frame, dict):
            normalized.append(frame)
    return normalized


def discover_chunk_entries(session_folder: Path, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []

    for entry in manifest.get("chunks", []):
        if not isinstance(entry, dict) or not entry.get("file"):
            continue

        candidate = Path(entry["file"])
        if not candidate.is_absolute():
            candidate = session_folder / candidate
        if candidate.exists():
            entries.append({
                "file": candidate,
                "segment": entry.get("segment", 1),
                "final": bool(entry.get("final", False)),
            })

    if entries:
        return entries

    def chunk_sort_key(path: Path) -> Tuple[int, int, str]:
        match = CHUNK_FILENAME_RE.match(path.name)
        if not match:
            return (sys.maxsize, sys.maxsize, path.name)
        return (int(match.group("sample")), int(match.group("chunk")), path.name)

    for candidate in sorted(session_folder.glob("sample*_chunk*.json"), key=chunk_sort_key):
        entries.append({"file": candidate, "segment": 1, "final": False})

    return entries


def frame_channels(frame: Dict[str, Any]) -> Dict[str, Any]:
    channels = frame.get("channels")
    if isinstance(channels, dict):
        return channels

    flattened: Dict[str, Any] = {}
    for key, value in frame.items():
        if key in RESERVED_FRAME_KEYS:
            continue
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            flattened[key] = value
    return flattened


def infer_label(channel_key: str, manifest: Dict[str, Any]) -> str:
    channel_names = manifest.get("channelNames")
    if isinstance(channel_names, dict):
        candidate = channel_names.get(channel_key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return str(channel_key)


def infer_signal_kind(label: str, manifest: Dict[str, Any], channel_key: str) -> Optional[str]:
    configured = manifest.get("channelSignalKinds")
    if not isinstance(configured, dict):
        return None

    configured_kind = configured.get(channel_key)
    if isinstance(configured_kind, str) and configured_kind.strip():
        normalized_kind = configured_kind.strip().lower()
        if normalized_kind in SUPPORTED_SIGNAL_KINDS:
            return normalized_kind
    return None


def channel_series(frames: Sequence[Dict[str, Any]], channel_key: str) -> Tuple[List[int], List[float]]:
    indices: List[int] = []
    values: List[float] = []

    for index, frame in enumerate(frames):
        channels = frame_channels(frame)
        if channel_key not in channels:
            continue
        value = safe_float(channels.get(channel_key))
        if value is None:
            continue
        indices.append(index)
        values.append(value)

    return indices, values


def group_entries_by_segment(entries: Sequence[Dict[str, Any]]) -> Dict[int, List[Path]]:
    grouped: Dict[int, List[Path]] = defaultdict(list)
    for entry in entries:
        segment = entry.get("segment", 1)
        try:
            segment_index = int(segment)
        except Exception:
            segment_index = 1
        grouped[segment_index].append(Path(entry["file"]))
    return dict(sorted(grouped.items(), key=lambda item: item[0]))


def basic_stats(values: Sequence[float]) -> Dict[str, Any]:
    if not values:
        return {"count": 0, "mean": None, "std": None, "min": None, "max": None}

    if len(values) == 1:
        return {
            "count": 1,
            "mean": values[0],
            "std": 0.0,
            "min": values[0],
            "max": values[0],
        }

    return {
        "count": len(values),
        "mean": mean(values),
        "std": pstdev(values),
        "min": min(values),
        "max": max(values),
    }


def export_series_csv(output_folder: Path, channel_name: str, indices: Sequence[int], values: Sequence[float], sample_rate: float) -> str:
    safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in channel_name).strip("_") or "channel"
    series_dir = output_folder / "channels"
    series_dir.mkdir(parents=True, exist_ok=True)
    csv_path = series_dir / f"{safe_name}.csv"

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["index", "time_seconds", "value"])
        for index, value in zip(indices, values):
            writer.writerow([index, index / sample_rate if sample_rate else index, value])

    return str(csv_path)


def serialize_df_like(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "to_dict"):
        try:
            return value.to_dict(orient="records")
        except Exception:
            try:
                return value.to_dict()
            except Exception:
                return str(value)
    return value


def serialize_numpy_like(value: Any) -> Any:
    if np is not None and hasattr(value, "tolist"):
        try:
            return value.tolist()
        except Exception:
            return str(value)
    if isinstance(value, (list, tuple)):
        return [serialize_numpy_like(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize_numpy_like(item) for key, item in value.items()}
    return value


def analyze_ecg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ecg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if biosppy_ecg is not None:
        try:
            result = biosppy_ecg.ecg(signal=signal, sampling_rate=float(sample_rate), show=False)
            record["libraries"].append("biosppy")
            if isinstance(result, dict):
                record["biosppy"] = {
                    key: serialize_numpy_like(result[key])
                    for key in ("rpeaks", "heart_rate", "heart_rate_ts", "ts")
                    if key in result
                }
            else:
                record["biosppy"] = {"result": serialize_numpy_like(result)}
        except Exception as exc:
            record.setdefault("warnings", []).append(f"BioSPPy ECG processing failed: {exc}")

    if nk is not None:
        try:
            signals, info = nk.ecg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            if info is not None:
                try:
                    hrv = nk.hrv(info, sampling_rate=float(sample_rate))
                    record["neurokit2"]["hrv"] = serialize_df_like(hrv)
                except Exception as exc:
                    record.setdefault("warnings", []).append(f"NeuroKit2 HRV processing failed: {exc}")
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 ECG processing failed: {exc}")

    return record


def analyze_eda(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eda", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if biosppy_eda is not None:
        try:
            result = biosppy_eda.eda(signal=signal, sampling_rate=float(sample_rate), show=False)
            record["libraries"].append("biosppy")
            record["biosppy"] = {"result": serialize_numpy_like(result)}
        except Exception as exc:
            record.setdefault("warnings", []).append(f"BioSPPy EDA processing failed: {exc}")

    if nk is not None:
        try:
            signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EDA processing failed: {exc}")

    return record


def analyze_ppg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ppg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if biosppy_ppg is not None:
        try:
            result = biosppy_ppg.ppg(signal=signal, sampling_rate=float(sample_rate), show=False)
            record["libraries"].append("biosppy")
            record["biosppy"] = {"result": serialize_numpy_like(result)}
        except Exception as exc:
            record.setdefault("warnings", []).append(f"BioSPPy PPG processing failed: {exc}")

    if nk is not None:
        try:
            signals, info = nk.ppg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 PPG processing failed: {exc}")

    return record


def analyze_emg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "emg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if biosppy_emg is not None:
        try:
            result = biosppy_emg.emg(signal=signal, sampling_rate=float(sample_rate), show=False)
            record["libraries"].append("biosppy")
            record["biosppy"] = {"result": serialize_numpy_like(result)}
        except Exception as exc:
            record.setdefault("warnings", []).append(f"BioSPPy EMG processing failed: {exc}")

    if nk is not None:
        try:
            signals, info = nk.emg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EMG processing failed: {exc}")

    return record


def analyze_rsp(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "rsp", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if biosppy_rsp is not None:
        try:
            result = biosppy_rsp.rsp(signal=signal, sampling_rate=float(sample_rate), show=False)
            record["libraries"].append("biosppy")
            record["biosppy"] = {"result": serialize_numpy_like(result)}
        except Exception as exc:
            record.setdefault("warnings", []).append(f"BioSPPy RSP processing failed: {exc}")

    if nk is not None:
        try:
            signals, info = nk.rsp_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 RSP processing failed: {exc}")

    return record


def analyze_eog(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eog", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if nk is not None:
        try:
            signals, info = nk.eog_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EOG processing failed: {exc}")

    return record


def analyze_generic(values: Sequence[float]) -> Dict[str, Any]:
    return {"signalKind": "generic", "libraries": [], "summary": basic_stats(values)}


def analyze_channel(channel_key: str, label: str, kind: Optional[str], values: Sequence[float], sample_rate: float, indices: Sequence[int], output_folder: Path) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "channel": channel_key,
        "label": label,
        "signalKind": kind or "generic",
        "summary": basic_stats(values),
        "seriesPath": export_series_csv(output_folder, label or channel_key, indices, values, sample_rate),
    }

    if not values:
        record["warnings"] = ["No numeric samples found for channel"]
        return record

    if kind == "ecg":
        record["analysis"] = analyze_ecg(values, sample_rate)
    elif kind == "eda":
        record["analysis"] = analyze_eda(values, sample_rate)
    elif kind == "ppg":
        record["analysis"] = analyze_ppg(values, sample_rate)
    elif kind == "emg":
        record["analysis"] = analyze_emg(values, sample_rate)
    elif kind == "rsp":
        record["analysis"] = analyze_rsp(values, sample_rate)
    elif kind == "eog":
        record["analysis"] = analyze_eog(values, sample_rate)
    else:
        record["analysis"] = analyze_generic(values)
        record.setdefault("warnings", []).append(
            "No specific library mapping was found for this channel; exported raw series and basic statistics only."
        )

    return record


def process_segment(segment_index: int, manifest: Dict[str, Any], chunk_files: Sequence[Path], output_folder: Path) -> Dict[str, Any]:
    frames: List[Dict[str, Any]] = []
    for chunk_file in chunk_files:
        frames.extend(load_chunk_frames(chunk_file))

    sample_rate = float(manifest.get("sampleRate") or manifest.get("samplingRate") or 1000.0)
    frame_count = len(frames)

    if frame_count == 0:
        return {
            "segment": segment_index,
            "chunkFiles": [str(path) for path in chunk_files],
            "frameCount": 0,
            "channels": [],
            "warnings": ["Segment contains no frames to process"],
        }

    channels = sorted({key for frame in frames for key in frame_channels(frame).keys()})
    result_channels: List[Dict[str, Any]] = []
    for channel_key in channels:
        label = infer_label(channel_key, manifest)
        kind = infer_signal_kind(label, manifest, channel_key)
        indices, values = channel_series(frames, channel_key)
        result_channels.append(
            analyze_channel(
                channel_key=channel_key,
                label=label,
                kind=kind,
                values=values,
                sample_rate=sample_rate,
                indices=indices,
                output_folder=output_folder / f"segment-{segment_index}",
            )
        )

    return {
        "segment": segment_index,
        "sampleRate": sample_rate,
        "frameCount": frame_count,
        "chunkFiles": [str(path) for path in chunk_files],
        "channels": result_channels,
        "warnings": [],
    }


def build_result(session_folder: Path, output_folder: Path) -> Dict[str, Any]:
    manifest = load_session_manifest(session_folder)
    chunk_entries = discover_chunk_entries(session_folder, manifest)
    if not chunk_entries:
        raise FileNotFoundError(f"No chunk files found in {session_folder}")

    grouped_entries = group_entries_by_segment(chunk_entries)
    segment_results: List[Dict[str, Any]] = []
    total_frames = 0
    total_chunks = 0

    for segment_index, segment_files in grouped_entries.items():
        segment_result = process_segment(segment_index, manifest, segment_files, output_folder)
        segment_results.append(segment_result)
        total_frames += int(segment_result.get("frameCount", 0) or 0)
        total_chunks += len(segment_files)

    sample_rate = float(manifest.get("sampleRate") or manifest.get("samplingRate") or 1000.0)

    return {
        "sessionId": manifest.get("sessionId"),
        "sessionFolder": str(session_folder),
        "sampleRate": sample_rate,
        "frameCount": total_frames,
        "chunkCount": total_chunks,
        "chunkFiles": [str(entry["file"]) for entry in chunk_entries],
        "analyzedAt": now_iso(),
        "completedAt": now_iso(),
        "worker": {
            "name": "python-analysis-worker",
            "biosppyAvailable": biosppy_ecg is not None,
            "neurokit2Available": nk is not None,
        },
        "segments": segment_results,
        "warnings": [],
    }


def write_summary_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "analysis-summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "segment",
            "channel",
            "label",
            "signalKind",
            "count",
            "mean",
            "std",
            "min",
            "max",
            "libraries",
            "seriesPath",
        ])
        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
                summary = channel.get("summary", {}) if isinstance(channel, dict) else {}
                analysis = channel.get("analysis", {}) if isinstance(channel, dict) else {}
                writer.writerow([
                    segment_index,
                    channel.get("channel"),
                    channel.get("label"),
                    channel.get("signalKind"),
                    summary.get("count"),
                    summary.get("mean"),
                    summary.get("std"),
                    summary.get("min"),
                    summary.get("max"),
                    ",".join(analysis.get("libraries", [])) if isinstance(analysis.get("libraries"), list) else "",
                    channel.get("seriesPath"),
                ])


def main() -> int:
    args = parse_args()
    session_folder = Path(args.session_folder).resolve()
    output_folder = Path(args.output_folder).resolve()
    output_folder.mkdir(parents=True, exist_ok=True)

    try:
        result = build_result(session_folder, output_folder)
        result_path = output_folder / "analysis-result.json"
        write_summary_csv(output_folder, result)
        with result_path.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, ensure_ascii=False)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        return 0
    except Exception as exc:
        error = {
            "error": str(exc),
            "sessionFolder": str(session_folder),
            "outputFolder": str(output_folder),
            "failedAt": now_iso(),
        }
        sys.stderr.write(json.dumps(error, ensure_ascii=False))
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
