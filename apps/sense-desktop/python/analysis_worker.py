#!/usr/bin/env python3
"""Post-hoc analysis worker for SENSE Desktop.

Input:
  --session-folder  Folder that contains session.json and chunk files
  --output-folder   Folder where analysis artifacts should be written

Output:
  Writes analysis-result.json, analysis-summary.csv, analysis-biosppy-features.csv,
  and per-channel series CSVs under output-folder.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is a runtime dependency
    np = None

try:
    import neurokit2 as nk
except Exception:  # pragma: no cover - optional until dependency is installed
    nk = None

try:
    from signal_processor import (
        SUPPORTED_SIGNAL_KINDS as BIOSPPY_SUPPORTED_SIGNAL_KINDS,
        process_signal as process_biosppy_signal,
    )
except Exception:  # pragma: no cover - wrapper should be present in production
    BIOSPPY_SUPPORTED_SIGNAL_KINDS = set()
    process_biosppy_signal = None

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
    parser.add_argument(
        "--eda-method",
        default=os.environ.get("SENSE_ANALYSIS_EDA_METHOD", "").strip() or "cvxEDA",
        help=(
            "NeuroKit2 EDA decomposition method passed to nk.eda_process "
            "(default: cvxEDA). Override for benchmarking, e.g. 'smoothmedian'."
        ),
    )
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


def resolve_sample_rate(manifest: Dict[str, Any]) -> float:
    raw = manifest.get("sampleRate")
    if raw is None:
        raw = manifest.get("samplingRate")
    if raw is None:
        raise ValueError(
            "Session manifest is missing 'sampleRate' (or 'samplingRate'); "
            "refusing to guess a default because analysis on the wrong timebase "
            "would produce plausible-looking but incorrect results."
        )
    rate = safe_float(raw)
    if rate is None or rate <= 0:
        raise ValueError(
            f"Session manifest has an invalid sample rate: {raw!r}. "
            "Expected a positive number in Hz."
        )
    return rate


def normalize_signal_kind_map(raw_map: Any) -> Dict[str, str]:
    if not isinstance(raw_map, dict):
        return {}

    normalized: Dict[str, str] = {}
    for channel, kind in raw_map.items():
        if not isinstance(channel, str) or not isinstance(kind, str):
            continue
        candidate = kind.strip().lower()
        if candidate in SUPPORTED_SIGNAL_KINDS:
            normalized[channel] = candidate
    return normalized


def load_signal_kind_overrides() -> Dict[str, str]:
    raw = os.environ.get("SENSE_ANALYSIS_SIGNAL_KINDS_JSON", "").strip()
    if not raw:
        return {}

    try:
        parsed = json.loads(raw)
    except Exception:
        return {}

    return normalize_signal_kind_map(parsed)


def merge_signal_kind_maps(manifest: Dict[str, Any], overrides: Dict[str, str]) -> Dict[str, str]:
    merged = normalize_signal_kind_map(manifest.get("channelSignalKinds"))
    for channel, kind in overrides.items():
        if channel and kind in SUPPORTED_SIGNAL_KINDS:
            merged[channel] = kind
    return merged


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
            entries.append(
                {
                    "file": candidate,
                    "segment": entry.get("segment", 1),
                    "final": bool(entry.get("final", False)),
                }
            )

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
        if not isinstance(value, bool) and safe_float(value) is not None:
            flattened[key] = value
    return flattened


def infer_label(channel_key: str, manifest: Dict[str, Any]) -> str:
    channel_names = manifest.get("channelNames")
    if isinstance(channel_names, dict):
        candidate = channel_names.get(channel_key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return str(channel_key)


def infer_signal_kind(manifest: Dict[str, Any], channel_key: str) -> Optional[str]:
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


def export_series_csv(
    output_folder: Path,
    channel_name: str,
    indices: Sequence[int],
    values: Sequence[float],
    sample_rate: float,
) -> str:
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


def sanitize_for_json(value: Any) -> Any:
    """Replace NaN/Infinity floats with None so the result is strict JSON.

    Python's json.dump emits NaN/Infinity as literals by default, which JS
    strict parsers (e.g. Electron renderer's JSON.parse) reject. Walk the
    structure once before serialization and convert any NaN/Inf to None.
    """
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        return {key: sanitize_for_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_for_json(item) for item in value]
    return value


# Sample-length arrays from biosppy.output / neurokit2.info (filtered signals,
# ECG_Quality, beat templates, etc.) duplicate data already exported as
# per-channel CSVs and bloat the result JSON from MBs to GBs on long sessions.
# Anything over this threshold is replaced with a placeholder string. Event
# arrays like R-peaks (~8.6k for a 2h ECG at 72bpm) stay below the limit.
ARRAY_PRESERVE_LIMIT = 10000


def prune_bulky_arrays(value: Any, limit: int = ARRAY_PRESERVE_LIMIT) -> Any:
    if isinstance(value, list):
        if len(value) > limit:
            return f"<array of {len(value)} items dropped — see channel CSV>"
        return [prune_bulky_arrays(item, limit) for item in value]
    if isinstance(value, dict):
        return {key: prune_bulky_arrays(item, limit) for key, item in value.items()}
    return value


def apply_biosppy_analysis(record: Dict[str, Any], kind: str, values: Sequence[float], sample_rate: float) -> None:
    if process_biosppy_signal is None:
        record.setdefault("warnings", []).append("BioSPPy wrapper is unavailable in this environment.")
        return

    payload = process_biosppy_signal(kind, values, sample_rate)
    if not isinstance(payload, dict):
        record.setdefault("warnings", []).append("BioSPPy wrapper returned an unexpected payload.")
        return

    warnings = payload.get("warnings", [])
    if isinstance(warnings, list):
        for warning in warnings:
            if isinstance(warning, str) and warning:
                record.setdefault("warnings", []).append(warning)

    if payload.get("available"):
        record["libraries"].append("biosppy")

    output = payload.get("output")
    if output is not None:
        record["biosppy"] = output

    features = payload.get("features")
    if isinstance(features, dict) and features:
        record["biosppyFeatures"] = features


def extract_neurokit2_features(record: Dict[str, Any]) -> None:
    nk_block = record.get("neurokit2") if isinstance(record, dict) else None
    if not isinstance(nk_block, dict):
        return

    features: Dict[str, Any] = {}

    info = nk_block.get("info")
    if isinstance(info, dict):
        for key, value in info.items():
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and not (
                isinstance(value, float) and (math.isnan(value) or math.isinf(value))
            ):
                features[str(key)] = value

    hrv = nk_block.get("hrv")
    hrv_rows: List[Dict[str, Any]] = []
    if isinstance(hrv, list):
        hrv_rows = [row for row in hrv if isinstance(row, dict)]
    elif isinstance(hrv, dict):
        hrv_rows = [hrv]

    for row in hrv_rows:
        for key, value in row.items():
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and not (
                isinstance(value, float) and (math.isnan(value) or math.isinf(value))
            ):
                features[str(key)] = value

    if features:
        record["neurokit2Features"] = features


def analyze_ecg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ecg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    apply_biosppy_analysis(record, "ecg", values, sample_rate)

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


def analyze_eda(values: Sequence[float], sample_rate: float, eda_method: Optional[str]) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eda", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    apply_biosppy_analysis(record, "eda", values, sample_rate)

    if nk is not None:
        try:
            method_used = None
            # If an override is provided, try to use it. If the installed
            # neurokit2 does not accept the 'method' argument, fall back
            # to the default call.
            try:
                if eda_method:
                    signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate), method=eda_method)
                    method_used = eda_method
                else:
                    signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))
            except TypeError:
                # Older/newer versions of neurokit2 may not accept `method`.
                signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))
                method_used = None

            record["libraries"].append("neurokit2")
            nk_block: Dict[str, Any] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            if method_used:
                nk_block["method"] = method_used
            record["neurokit2"] = nk_block
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EDA processing failed: {exc}")

    return record


def analyze_ppg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ppg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    apply_biosppy_analysis(record, "ppg", values, sample_rate)

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

    apply_biosppy_analysis(record, "emg", values, sample_rate)

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

    apply_biosppy_analysis(record, "rsp", values, sample_rate)

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


def analyze_eeg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eeg", "libraries": []}
    apply_biosppy_analysis(record, "eeg", values, sample_rate)
    return record


def analyze_pcg(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "pcg", "libraries": []}
    apply_biosppy_analysis(record, "pcg", values, sample_rate)
    return record


def analyze_acc(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "acc", "libraries": []}
    apply_biosppy_analysis(record, "acc", values, sample_rate)
    return record


def analyze_generic(values: Sequence[float]) -> Dict[str, Any]:
    return {"signalKind": "generic", "libraries": []}


def analyze_channel(
    channel_key: str,
    label: str,
    kind: Optional[str],
    values: Sequence[float],
    sample_rate: float,
    indices: Sequence[int],
    output_folder: Path,
    eda_method: Optional[str],
) -> Dict[str, Any]:
    normalized_kind = (kind or "").lower()
    if normalized_kind == "acc":
        normalized_kind = "acc"

    record: Dict[str, Any] = {
        "channel": channel_key,
        "label": label,
        "signalKind": normalized_kind or "generic",
        "summary": basic_stats(values),
        "seriesPath": export_series_csv(output_folder, label or channel_key, indices, values, sample_rate),
    }

    if not values:
        record["warnings"] = ["No numeric samples found for channel"]
        return record

    if normalized_kind == "ecg":
        record["analysis"] = analyze_ecg(values, sample_rate)
    elif normalized_kind == "eda":
        record["analysis"] = analyze_eda(values, sample_rate, eda_method)
    elif normalized_kind == "ppg":
        record["analysis"] = analyze_ppg(values, sample_rate)
    elif normalized_kind == "emg":
        record["analysis"] = analyze_emg(values, sample_rate)
    elif normalized_kind == "rsp":
        record["analysis"] = analyze_rsp(values, sample_rate)
    elif normalized_kind == "eog":
        record["analysis"] = analyze_eog(values, sample_rate)
    elif normalized_kind == "eeg":
        record["analysis"] = analyze_eeg(values, sample_rate)
    elif normalized_kind == "pcg":
        record["analysis"] = analyze_pcg(values, sample_rate)
    elif normalized_kind == "acc":
        record["analysis"] = analyze_acc(values, sample_rate)
    else:
        record["analysis"] = analyze_generic(values)
        record.setdefault("warnings", []).append(
            "No specific library mapping was found for this channel; exported raw series and basic statistics only."
        )

    analysis_record = record.get("analysis")
    if isinstance(analysis_record, dict):
        extract_neurokit2_features(analysis_record)

    return record


def process_segment(
    segment_index: int,
    manifest: Dict[str, Any],
    sample_rate: float,
    chunk_files: Sequence[Path],
    output_folder: Path,
    eda_method: Optional[str],
) -> Dict[str, Any]:
    frames: List[Dict[str, Any]] = []
    for chunk_file in chunk_files:
        frames.extend(load_chunk_frames(chunk_file))

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
        kind = infer_signal_kind(manifest, channel_key)
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
                eda_method=eda_method,
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


def build_result(session_folder: Path, output_folder: Path, eda_method: Optional[str]) -> Dict[str, Any]:
    manifest = load_session_manifest(session_folder)
    sample_rate = resolve_sample_rate(manifest)
    chunk_entries = discover_chunk_entries(session_folder, manifest)
    if not chunk_entries:
        raise FileNotFoundError(f"No chunk files found in {session_folder}")

    selected_signal_kinds = load_signal_kind_overrides()
    analysis_manifest = dict(manifest)
    analysis_manifest["channelSignalKinds"] = merge_signal_kind_maps(manifest, selected_signal_kinds)

    grouped_entries = group_entries_by_segment(chunk_entries)
    segment_results: List[Dict[str, Any]] = []
    total_frames = 0
    total_chunks = 0

    for segment_index, segment_files in grouped_entries.items():
        segment_result = process_segment(
            segment_index,
            analysis_manifest,
            sample_rate,
            segment_files,
            output_folder,
            eda_method,
        )
        segment_results.append(segment_result)
        total_frames += int(segment_result.get("frameCount", 0) or 0)
        total_chunks += len(segment_files)

    biosppy_strategy = ["ecg", "eda", "ppg", "emg", "rsp", "eeg", "pcg", "acc"]

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
            "biosppyAvailable": process_biosppy_signal is not None,
            "neurokit2Available": nk is not None,
            "libraryStrategy": {
                "biosppy": biosppy_strategy,
                "neurokit2": ["ecg", "eda", "ppg", "emg", "rsp", "eog", "hrv"],
            },
        },
        "analysisConfig": {
            "batchMode": "load-session-process-entire-dataset-store-features",
            "channelSignalKinds": analysis_manifest.get("channelSignalKinds", {}),
            "signalKindOverrides": selected_signal_kinds,
            "edaMethod": eda_method or "neurokit2-default",
        },
        "segments": segment_results,
        "warnings": [],
    }


def write_summary_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "analysis-summary.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
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
            ]
        )
        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
                summary = channel.get("summary", {}) if isinstance(channel, dict) else {}
                analysis = channel.get("analysis", {}) if isinstance(channel, dict) else {}
                writer.writerow(
                    [
                        segment_index,
                        channel.get("channel"),
                        channel.get("label"),
                        channel.get("signalKind"),
                        summary.get("count"),
                        summary.get("mean"),
                        summary.get("std"),
                        summary.get("min"),
                        summary.get("max"),
                        ",".join(analysis.get("libraries", []))
                        if isinstance(analysis.get("libraries"), list)
                        else "",
                        channel.get("seriesPath"),
                    ]
                )


def write_biosppy_features_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "analysis-biosppy-features.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["segment", "channel", "label", "signalKind", "feature", "value"])

        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            channels = segment.get("channels", []) if isinstance(segment, dict) else []
            for channel in channels:
                if not isinstance(channel, dict):
                    continue
                analysis = channel.get("analysis", {})
                if not isinstance(analysis, dict):
                    continue
                features = analysis.get("biosppyFeatures", {})
                if not isinstance(features, dict):
                    continue

                for feature_name, value in sorted(features.items(), key=lambda item: item[0]):
                    if isinstance(value, (int, float, str, bool)) or value is None:
                        serialized = value
                    else:
                        serialized = json.dumps(value, ensure_ascii=False)

                    writer.writerow(
                        [
                            segment_index,
                            channel.get("channel"),
                            channel.get("label"),
                            channel.get("signalKind"),
                            feature_name,
                            serialized,
                        ]
                    )


def write_neurokit2_features_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "analysis-neurokit2-features.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["segment", "channel", "label", "signalKind", "feature", "value"])

        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            channels = segment.get("channels", []) if isinstance(segment, dict) else []
            for channel in channels:
                if not isinstance(channel, dict):
                    continue
                analysis = channel.get("analysis", {})
                if not isinstance(analysis, dict):
                    continue
                features = analysis.get("neurokit2Features", {})
                if not isinstance(features, dict):
                    continue

                for feature_name, value in sorted(features.items(), key=lambda item: item[0]):
                    if isinstance(value, (int, float, str, bool)) or value is None:
                        serialized = value
                    else:
                        serialized = json.dumps(value, ensure_ascii=False)

                    writer.writerow(
                        [
                            segment_index,
                            channel.get("channel"),
                            channel.get("label"),
                            channel.get("signalKind"),
                            feature_name,
                            serialized,
                        ]
                    )


def main() -> int:
    args = parse_args()
    session_folder = Path(args.session_folder).resolve()
    output_folder = Path(args.output_folder).resolve()
    output_folder.mkdir(parents=True, exist_ok=True)

    try:
        session_name = session_folder.name
        analysis_started = time.perf_counter()
        result = build_result(
            session_folder,
            output_folder,
            args.eda_method,
        )
        analyze_seconds = time.perf_counter() - analysis_started
        chunk_count = int(result.get("chunkCount") or 0)
        frame_count = int(result.get("frameCount") or 0)
        sample_rate = result.get("sampleRate")
        sample_rate_suffix = f" @ {sample_rate}Hz" if sample_rate else ""
        print(
            f"[analysis][{session_name}] analysis phase done in {analyze_seconds:.2f}s, writing outputs...",
            flush=True,
        )

        # Drop sample-length arrays from biosppy/neurokit2 payloads (duplicates
        # of the per-channel CSV exports), then replace NaN/Inf with None so
        # the Electron renderer's strict JSON.parse can read it.
        result = prune_bulky_arrays(result)
        result = sanitize_for_json(result)
        result_path = output_folder / "analysis-result.json"
        write_summary_csv(output_folder, result)
        write_biosppy_features_csv(output_folder, result)
        write_neurokit2_features_csv(output_folder, result)
        with result_path.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, ensure_ascii=False, allow_nan=False)
        total_seconds = time.perf_counter() - analysis_started
        result_size_mb = result_path.stat().st_size / (1024)
        print(
            f"[{session_name}] done in {total_seconds:.2f}s "
            f"(analysis {analyze_seconds:.2f}s + outputs {total_seconds - analyze_seconds:.2f}s) "
            f"— {chunk_count} chunks, {frame_count} frames"
            f"{sample_rate_suffix} (eda_method={args.eda_method}, "
            f"result.json={result_size_mb:.1f}KB)",
            flush=True,
        )
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
