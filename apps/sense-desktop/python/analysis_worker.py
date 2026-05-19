#!/usr/bin/env python3
"""Post-hoc analysis worker for SENSE Desktop.

Input:
  --session-folder  Folder that contains session.json and chunk files
  --output-folder   Folder where analysis artifacts should be written

Output:
  Writes analysis.json, summary.csv, features.csv, per-channel series CSVs, and
  one raw-signal CSV per segment (segment-N/signal.csv) under output-folder.
  The signal CSVs reproduce the canonical ScientISST `sense.py` FileWriter
  layout in `mv=False` mode (github.com/scientisst/scientisst-sense-api-python):
  a `#{...}` Python-dict metadata line, a tab-separated
  `#NSeq I1 I2 O1 O2 AI1_raw AI2_raw ...` column header, then one tab-separated
  row per acquired frame, so a recording can be loaded with the same tools as
  a sense.py acquisition.

All signals (ECG, EDA, PPG, EMG, RSP, EOG, EEG, PCG, ACC) are analyzed full-length
across the whole session.
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
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

try:
    import numpy as np
except Exception: 
    np = None

try:
    import neurokit2 as nk
except Exception:  
    nk = None

try:
    from signal_processor import (
        SUPPORTED_SIGNAL_KINDS as BIOSPPY_SUPPORTED_SIGNAL_KINDS,
        process_signal as process_biosppy_signal,
    )
except Exception:  
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
ACC_AXIS_ORDER = {"x": 0, "y": 1, "z": 2}

# --- ScientISST sense.py FileWriter compatibility ---------------------------
SENSE_FILEWRITER_API_VERSION = "1.2.0"
SENSE_CHANNEL_RESOLUTION_BITS = {
    "AI1": 12, "AI2": 12, "AI3": 12, "AI4": 12, "AI5": 12, "AI6": 12,
    "AX1": 24, "AX2": 24,
}
SENSE_DEFAULT_CHANNEL_RESOLUTION_BITS = 12


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run post-hoc signal analysis for a SENSE session")
    parser.add_argument("--session-folder", required=True, help="Path to a session folder")
    parser.add_argument("--output-folder", required=True, help="Path to the analysis output folder")
    parser.add_argument(
        "--eda-method",
        default=os.environ.get("SENSE_ANALYSIS_EDA_METHOD", "").strip() or "neurokit",
        help=(
            "NeuroKit2 EDA cleaning method passed to nk.eda_process "
            "(one of 'neurokit' or 'biosppy'; default: neurokit)."
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


def normalize_signal_axis_map(raw_map: Any) -> Dict[str, str]:
    if not isinstance(raw_map, dict):
        return {}

    normalized: Dict[str, str] = {}
    for channel, axis in raw_map.items():
        if not isinstance(channel, str) or not isinstance(axis, str):
            continue
        candidate = axis.strip().lower()
        if candidate in ACC_AXIS_ORDER:
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


def load_signal_axis_overrides() -> Dict[str, str]:
    raw = os.environ.get("SENSE_ANALYSIS_SIGNAL_AXES_JSON", "").strip()
    if not raw:
        return {}

    try:
        parsed = json.loads(raw)
    except Exception:
        return {}

    return normalize_signal_axis_map(parsed)


def merge_signal_kind_maps(manifest: Dict[str, Any], overrides: Dict[str, str]) -> Dict[str, str]:
    merged = normalize_signal_kind_map(manifest.get("channelSignalKinds"))
    for channel, kind in overrides.items():
        if channel and kind in SUPPORTED_SIGNAL_KINDS:
            merged[channel] = kind
    return merged


def merge_signal_axis_maps(manifest: Dict[str, Any], overrides: Dict[str, str]) -> Dict[str, str]:
    merged = normalize_signal_axis_map(manifest.get("channelSignalAxes"))
    for channel, axis in overrides.items():
        if channel and axis in ACC_AXIS_ORDER:
            merged[channel] = axis
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


def infer_signal_axis(manifest: Dict[str, Any], channel_key: str) -> Optional[str]:
    configured = manifest.get("channelSignalAxes")
    if not isinstance(configured, dict):
        return None

    configured_axis = configured.get(channel_key)
    if isinstance(configured_axis, str) and configured_axis.strip():
        normalized_axis = configured_axis.strip().lower()
        if normalized_axis in ACC_AXIS_ORDER:
            return normalized_axis
    return None


def channel_matrix_series(
    frames: Sequence[Dict[str, Any]],
    channel_keys: Sequence[str],
) -> Tuple[List[int], List[List[float]]]:
    indices: List[int] = []
    values: List[List[float]] = []

    for index, frame in enumerate(frames):
        channels = frame_channels(frame)
        row: List[float] = []
        valid = True

        for channel_key in channel_keys:
            value = safe_float(channels.get(channel_key))
            if value is None:
                valid = False
                break
            row.append(value)

        if not valid:
            continue

        indices.append(index)
        values.append(row)

    return indices, values


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


def count_progress_units(
    grouped_entries: Dict[int, List[Path]],
    manifest: Dict[str, Any],
) -> Tuple[int, int]:
    biosppy_total = 0
    neurokit2_total = 0

    for segment_files in grouped_entries.values():
        frames: List[Dict[str, Any]] = []
        for chunk_file in segment_files:
            frames.extend(load_chunk_frames(chunk_file))

        channels = sorted({key for frame in frames for key in frame_channels(frame).keys()})
        acc_group_counted = False
        for channel_key in channels:
            normalized_kind = (infer_signal_kind(manifest, channel_key) or "").lower()
            normalized_axis = infer_signal_axis(manifest, channel_key) if normalized_kind == "acc" else None
            if normalized_kind == "acc" and normalized_axis in ACC_AXIS_ORDER:
                if not acc_group_counted:
                    biosppy_total += 1
                    acc_group_counted = True
                continue
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS:
                biosppy_total += 1
            if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                neurokit2_total += 1

    return biosppy_total, neurokit2_total


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
    """Export a channel's full-session series to a single CSV."""
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in channel_name
    ).strip("_") or "channel"
    series_dir = output_folder / "channels"
    series_dir.mkdir(parents=True, exist_ok=True)
    csv_path = series_dir / f"{safe_name}.csv"

    header = "index,time_seconds,value\n"
    if not indices:
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write(header)
        return str(csv_path)

    if np is not None:
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write(header)
            idx_arr = np.asarray(indices, dtype=np.int64)
            val_arr = np.asarray(values, dtype=np.float64)
            time_arr = (idx_arr / sample_rate) if sample_rate else idx_arr.astype(np.float64)
            stacked = np.column_stack([idx_arr, time_arr, val_arr])
            np.savetxt(
                handle,
                stacked,
                delimiter=",",
                fmt=["%d", "%.9g", "%.9g"],
            )
        return str(csv_path)

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

ARRAY_PRESERVE_LIMIT = 10000

PROGRESS_STAGE_WEIGHTS = {
    "data_prep": 5.0,
    "biosppy": 60.0,
    "neurokit2": 30.0,
    "csv": 5.0,
}

BIOSPPY_PROGRESS_SIGNAL_KINDS = {"ecg", "eda", "ppg", "emg", "rsp", "eeg", "pcg", "acc"}
NEUROKIT2_PROGRESS_SIGNAL_KINDS = {"ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg"}


class AnalysisProgressTracker:
    def __init__(self, biosppy_total: int, neurokit2_total: int) -> None:
        self.biosppy_total = max(0, int(biosppy_total))
        self.neurokit2_total = max(0, int(neurokit2_total))
        self.biosppy_done = 0.0
        self.neurokit2_done = 0.0
        self.data_prepared = False
        self.csv_written = False
        self.last_percentage = -1
        self.last_emitted_label = ""
        self.biosppy_started = False
        self.neurokit2_started = False

        self.total_weight = PROGRESS_STAGE_WEIGHTS["data_prep"] + PROGRESS_STAGE_WEIGHTS["csv"]
        if self.biosppy_total > 0:
            self.total_weight += PROGRESS_STAGE_WEIGHTS["biosppy"]
        if self.neurokit2_total > 0:
            self.total_weight += PROGRESS_STAGE_WEIGHTS["neurokit2"]

    def _current_percentage(self) -> int:
        completed_weight = 0.0
        if self.data_prepared:
            completed_weight += PROGRESS_STAGE_WEIGHTS["data_prep"]
        if self.biosppy_total > 0:
            completed_weight += PROGRESS_STAGE_WEIGHTS["biosppy"] * min(1.0, self.biosppy_done / self.biosppy_total)
        if self.neurokit2_total > 0:
            completed_weight += PROGRESS_STAGE_WEIGHTS["neurokit2"] * min(1.0, self.neurokit2_done / self.neurokit2_total)
        if self.csv_written:
            completed_weight += PROGRESS_STAGE_WEIGHTS["csv"]

        if self.total_weight <= 0:
            return 100

        percentage = int((completed_weight / self.total_weight) * 100)
        return min(100, max(0, percentage))

    def emit(self, label: str, force: bool = False) -> None:
        """Emit progress update. Prints if label changed, percentage increased, or force=True."""
        percentage = self._current_percentage()
        label_changed = label != self.last_emitted_label
        percentage_changed = percentage > self.last_percentage
        
        if force or label_changed or percentage_changed:
            print(f"[progress] {percentage}% {label}", flush=True)
            self.last_percentage = percentage
            self.last_emitted_label = label

    def mark_data_prepared(self) -> None:
        self.data_prepared = True
        self.emit("Data preparation complete")

    def start_analysis(self) -> None:
        """Emit initialization message for analysis phase."""
        if not self.biosppy_started and self.biosppy_total > 0:
            self.biosppy_started = True
            if not self.neurokit2_started and self.neurokit2_total > 0:
                self.neurokit2_started = True
                self.emit("Initializing analysis", force=True)

    def advance_biosppy(self, amount: float, label: str) -> None:
        if self.biosppy_total <= 0 or amount <= 0:
            return
        self.biosppy_done = min(float(self.biosppy_total), self.biosppy_done + amount)
        self.emit(label)

    def advance_neurokit2(self, amount: float, label: str) -> None:
        if self.neurokit2_total <= 0 or amount <= 0:
            return
        self.neurokit2_done = min(float(self.neurokit2_total), self.neurokit2_done + amount)
        self.emit(label)

    def mark_csv_written(self) -> None:
        self.csv_written = True
        self.emit("CSV summaries written")


def prune_bulky_arrays(value: Any, limit: int = ARRAY_PRESERVE_LIMIT) -> Any:
    if isinstance(value, list):
        if len(value) > limit:
            return f"<array of {len(value)} items dropped — see channel CSV>"
        return [prune_bulky_arrays(item, limit) for item in value]
    if isinstance(value, dict):
        return {key: prune_bulky_arrays(item, limit) for key, item in value.items()}
    return value


def _progress_label(signal_name: str, channel_key: Optional[str], phase: str) -> str:
    if channel_key:
        return f"{signal_name} ({channel_key}): {phase}"
    return f"{signal_name}: {phase}"


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

    def _is_finite_number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and not (
            isinstance(value, float) and (math.isnan(value) or math.isinf(value))
        )

    info = nk_block.get("info")
    if isinstance(info, dict):
        for key, value in info.items():
            if isinstance(value, bool):
                continue
            if _is_finite_number(value):
                features[str(key)] = value
            elif isinstance(value, (list, tuple)):
                numeric_values = [item for item in value if _is_finite_number(item)]
                if numeric_values:
                    stats = basic_stats(numeric_values)
                    for stat_name, stat_value in stats.items():
                        features[f"{key}_{stat_name}"] = stat_value

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
            if _is_finite_number(value):
                features[str(key)] = value

    derived = nk_block.get("derivedFeatures")
    if isinstance(derived, dict):
        for key, value in derived.items():
            if _is_finite_number(value):
                features[str(key)] = value

    if features:
        record["neurokit2Features"] = features


def analyze_ecg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ecg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ECG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "ecg", values, sample_rate)
    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy ECG", channel_key, "detecting peaks & features"))

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 ECG", channel_key, "processing & HRV"))

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

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ECG", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 ECG", channel_key, "complete"))

    return record


def analyze_eda(
    values: Sequence[float],
    sample_rate: float,
    eda_method: Optional[str],
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eda", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EDA", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "eda", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy EDA", channel_key, "detecting peaks & features"))

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EDA", channel_key, "processing & decomposition"))

            method_used = None
            try:
                if eda_method:
                    signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate), method=eda_method)
                    method_used = eda_method
                else:
                    signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))
            except (TypeError, ValueError):
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

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EDA", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 EDA", channel_key, "complete"))

    return record


def analyze_ppg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ppg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PPG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "ppg", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy PPG", channel_key, "detecting peaks & features"))

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 PPG", channel_key, "processing & features"))

            signals, info = nk.ppg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 PPG processing failed: {exc}")

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PPG", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 PPG", channel_key, "complete"))

    return record


def analyze_emg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "emg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EMG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "emg", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy EMG", channel_key, "detecting peaks & features"))

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EMG", channel_key, "processing & features"))

            signals, info = nk.emg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EMG processing failed: {exc}")

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EMG", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 EMG", channel_key, "complete"))

    return record


def analyze_rsp(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "rsp", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy RSP", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "rsp", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy RSP", channel_key, "detecting peaks & features"))

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 RSP", channel_key, "processing & features"))

            signals, info = nk.rsp_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 RSP processing failed: {exc}")

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy RSP", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 RSP", channel_key, "complete"))

    return record


def _extract_eog_features(signals: Any, info: Any, sample_rate: float) -> Dict[str, Any]:
    """Derive domain-specific EOG features from NeuroKit2's eog_process output:
    blink count, blink rate per minute, inter-blink-interval stats, and stats of
    the per-sample blink-rate signal.
    """
    features: Dict[str, Any] = {}
    if np is None:
        return features

    def _put(name: str, value: Any) -> None:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return
        if math.isnan(num) or math.isinf(num):
            return
        features[name] = num

    # --- Blink onsets: try common key names across NeuroKit2 versions ---
    blinks = None
    if isinstance(info, dict):
        for candidate in ("EOG_Blinks", "EOG_Onsets", "Blinks"):
            value = info.get(candidate)
            if value is None:
                continue
            arr = np.atleast_1d(np.asarray(value)).reshape(-1)
            if arr.size > 0:
                blinks = arr
                break

    n_samples = None
    try:
        n_samples = int(len(signals))
    except TypeError:
        n_samples = None

    if blinks is not None and blinks.size > 0:
        _put("EOG_Blinks_count", int(blinks.size))
        if n_samples and sample_rate > 0:
            duration_min = n_samples / (sample_rate * 60.0)
            if duration_min > 0:
                _put("EOG_Blink_Rate_per_min", blinks.size / duration_min)
        if blinks.size >= 2 and sample_rate > 0:
            intervals_s = np.diff(np.sort(blinks)) / sample_rate
            intervals_s = intervals_s[np.isfinite(intervals_s)]
            if intervals_s.size > 0:
                _put("EOG_IBI_Mean_s", float(np.mean(intervals_s)))
                _put("EOG_IBI_SD_s", float(np.std(intervals_s)))

    # --- Per-sample blink-rate column: try common names ---
    columns = list(getattr(signals, "columns", []))
    for candidate in ("EOG_Rate", "EOG_Rate_Mean"):
        if candidate not in columns:
            continue
        series = signals[candidate]
        series = series.dropna() if hasattr(series, "dropna") else series
        if getattr(series, "size", 0) > 0:
            _put("EOG_Rate_Mean", float(series.mean()))
            _put("EOG_Rate_SD", float(series.std()))
            _put("EOG_Rate_Min", float(series.min()))
            _put("EOG_Rate_Max", float(series.max()))
        break

    return features


def analyze_eog(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eog", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EOG", channel_key, "processing & features"))

            signals, info = nk.eog_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            nk_block: Dict[str, Any] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            derived = _extract_eog_features(signals, info, float(sample_rate))
            if derived:
                nk_block["derivedFeatures"] = derived
            record["neurokit2"] = nk_block
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EOG processing failed: {exc}")

    if progress is not None:
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 EOG", channel_key, "complete"))

    return record


def analyze_eeg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eeg", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)
    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EEG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "eeg", values, sample_rate)

    if nk is not None:
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EEG", channel_key, "processing & features"))

            signals, info = nk.eeg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EEG processing failed: {exc}")

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy EEG", channel_key, "detecting peaks & features"))
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EEG", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 EEG", channel_key, "complete"))
    return record


def analyze_pcg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "pcg", "libraries": []}
    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PCG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "pcg", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy PCG", channel_key, "detecting peaks & features"))
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PCG", channel_key, "complete"))
    return record


def analyze_acc(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "acc", "libraries": []}

    axis_count = 1
    if values and isinstance(values[0], (list, tuple)):
        axis_count = len(values[0])

    if axis_count <= 1:
        record["analysis"] = analyze_generic(values)
        record.setdefault("warnings", []).append(
            "BioSPPy ACC vector features require at least two axes; using scalar ACC fallback."
        )
        return record

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ACC", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "acc", values, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy ACC", channel_key, "detecting peaks & features"))
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ACC", channel_key, "complete"))
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
    progress: Optional[AnalysisProgressTracker] = None,
    analysis_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    normalized_kind = (kind or "").lower()
    if normalized_kind == "acc":
        normalized_kind = "acc"

    record: Dict[str, Any] = {
        "channel": channel_key,
        "label": label,
        "signalKind": normalized_kind or "generic",
        "summary": basic_stats(values),
    }

    record["_indices"] = indices
    record["_values"] = values
    record["_export_name"] = f"{channel_key}_{normalized_kind.upper()}" if normalized_kind else channel_key

    if not values:
        record["warnings"] = ["No numeric samples found for channel"]
        if progress is not None:
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS:
                progress.advance_biosppy(1, f"BioSPPy: {normalized_kind.upper()} ({label})")
            if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                progress.advance_neurokit2(1, f"NeuroKit2: {normalized_kind.upper()} ({label})")
        return record

    if analysis_override is not None:
        record["analysis"] = analysis_override
        analysis_record = record.get("analysis")
        return record

    if normalized_kind == "ecg":
        record["analysis"] = analyze_ecg(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "eda":
        record["analysis"] = analyze_eda(values, sample_rate, eda_method, channel_key=channel_key, progress=progress)
    elif normalized_kind == "ppg":
        record["analysis"] = analyze_ppg(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "emg":
        record["analysis"] = analyze_emg(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "rsp":
        record["analysis"] = analyze_rsp(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "eog":
        record["analysis"] = analyze_eog(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "eeg":
        record["analysis"] = analyze_eeg(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "pcg":
        record["analysis"] = analyze_pcg(values, sample_rate, channel_key=channel_key, progress=progress)
    elif normalized_kind == "acc":
        record["analysis"] = analyze_acc(values, sample_rate, channel_key=channel_key, progress=progress)
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
    progress: Optional[AnalysisProgressTracker] = None,
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
    acc_group_entries: List[Dict[str, Any]] = []
    for channel_key in channels:
        label = infer_label(channel_key, manifest)
        kind = infer_signal_kind(manifest, channel_key)
        axis = infer_signal_axis(manifest, channel_key) if (kind or "").lower() == "acc" else None
        
        if progress is not None:
            normalized_kind = (kind or "").lower()
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS and normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                progress.start_analysis()
        
        indices, values = channel_series(frames, channel_key)

        if (kind or "").lower() == "acc" and axis in ACC_AXIS_ORDER:
            if not values:
                result_channels.append({
                    "channel": channel_key,
                    "label": label,
                    "signalKind": kind or "generic",
                    "summary": {"count": 0, "mean": None, "std": None, "min": None, "max": None},
                    "warnings": ["Channel contains no valid samples"],
                    "accAxis": axis,
                })
                if progress is not None:
                    progress.advance_biosppy(1, f"BioSPPy: ACC ({label})")
                continue

            acc_group_entries.append({
                "channel": channel_key,
                "label": label,
                "kind": kind,
                "axis": axis,
                "indices": indices,
                "values": values,
            })
            continue

        if not values:
            result_channels.append({
                "channel": channel_key,
                "label": label,
                "signalKind": kind or "generic",
                "summary": {"count": 0, "mean": None, "std": None, "min": None, "max": None},
                "warnings": ["Channel contains no valid samples"],
            })
            if progress is not None:
                normalized_kind = (kind or "").lower()
                if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS:
                    progress.advance_biosppy(1, f"BioSPPy: {normalized_kind.upper()} ({label})")
                if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                    progress.advance_neurokit2(1, f"NeuroKit2: {normalized_kind.upper()} ({label})")
            continue

        channel_result = analyze_channel(
            channel_key=channel_key,
            label=label,
            kind=kind,
            values=values,
            sample_rate=sample_rate,
            indices=indices,
            output_folder=output_folder / f"segment-{segment_index}",
            eda_method=eda_method,
            progress=progress,
        )
        channel_record = dict(channel_result)
        channel_record["channel"] = channel_key
        channel_record["label"] = label
        channel_record["signalKind"] = kind or "generic"

        result_channels.append(channel_record)

    if acc_group_entries:
        # Validate: ACC can have at most 3 axes (X, Y, Z)
        if len(acc_group_entries) > 3:
            warnings = [f"ACC assigned to {len(acc_group_entries)} channels; only the first 3 (X, Y, Z) will be processed."]
            acc_group_entries = acc_group_entries[:3]
        else:
            warnings = []
        
        ordered_acc_entries = sorted(
            acc_group_entries,
            key=lambda entry: (ACC_AXIS_ORDER.get(str(entry.get("axis")), 99), str(entry.get("channel")))
        )
        acc_group_channels = [str(entry["channel"]) for entry in ordered_acc_entries]
        acc_group_label = ", ".join(str(entry["label"]) for entry in ordered_acc_entries if entry.get("label")) or "ACC"
        group_indices, group_values = channel_matrix_series(frames, acc_group_channels)

        if group_values:
            acc_analysis = analyze_acc(group_values, sample_rate, channel_key=acc_group_label, progress=progress)
        else:
            acc_analysis = {
                "signalKind": "acc",
                "libraries": [],
                "analysis": analyze_generic([]),
                "warnings": ["ACC axes could not be aligned into a shared multi-axis signal; using scalar fallbacks."],
            }
        
        if warnings:
            acc_analysis.setdefault("warnings", []).extend(warnings)

        for entry in ordered_acc_entries:
            channel_result = analyze_channel(
                channel_key=str(entry["channel"]),
                label=str(entry["label"]),
                kind=str(entry["kind"]),
                values=entry["values"],
                sample_rate=sample_rate,
                indices=entry["indices"],
                output_folder=output_folder / f"segment-{segment_index}",
                eda_method=eda_method,
                progress=None,
                analysis_override=acc_analysis,
            )
            channel_record = dict(channel_result)
            channel_record["channel"] = str(entry["channel"])
            channel_record["label"] = str(entry["label"])
            channel_record["signalKind"] = "acc"
            channel_record["accAxis"] = str(entry["axis"])
            channel_record["accGroupChannels"] = acc_group_channels
            channel_record["accGroupIndices"] = group_indices
            result_channels.append(channel_record)

    return {
        "segment": segment_index,
        "sampleRate": sample_rate,
        "frameCount": frame_count,
        "chunkFiles": [str(path) for path in chunk_files],
        "channels": result_channels,
        "warnings": [],
    }


def emit_progress(completed: int, total: int, signal_kind: str) -> None:
    if total > 0:
        percentage = int((completed / total) * 100)
        print(f"[progress] {percentage}% Analyzing {signal_kind.upper()}", flush=True)


def emit_phase_progress(signal_index: int, phase: str, total_signals: int) -> None:
    """Emit finer-grained progress within signal analysis.

    Phases: prepare, biosppy, neurokit2, hrv, writing
    Each signal gets ~20% of the bar, phases subdivide that.
    """
    if total_signals > 0:
        signal_base = (signal_index / total_signals) * 100
        phase_offsets = {
            "prepare": 0,
            "biosppy": 4,
            "neurokit2": 8,
            "hrv": 12,
            "writing": 16,
        }
        phase_offset = phase_offsets.get(phase, 0)
        percentage = int(signal_base + phase_offset)
        percentage = min(99, max(0, percentage))
        print(f"[progress] {percentage}% {phase.capitalize()}", flush=True)


def build_result(session_folder: Path, output_folder: Path, eda_method: Optional[str]) -> Tuple[Dict[str, Any], AnalysisProgressTracker]:
    print("[progress] 0% Loading chunks and parsing data", flush=True)
    manifest = load_session_manifest(session_folder)
    sample_rate = resolve_sample_rate(manifest)
    chunk_entries = discover_chunk_entries(session_folder, manifest)
    if not chunk_entries:
        raise FileNotFoundError(f"No chunk files found in {session_folder}")

    selected_signal_kinds = load_signal_kind_overrides()
    selected_signal_axes = load_signal_axis_overrides()
    analysis_manifest = dict(manifest)
    analysis_manifest["channelSignalKinds"] = merge_signal_kind_maps(manifest, selected_signal_kinds)
    analysis_manifest["channelSignalAxes"] = merge_signal_axis_maps(manifest, selected_signal_axes)

    grouped_entries = group_entries_by_segment(chunk_entries)
    segment_results: List[Dict[str, Any]] = []
    total_frames = 0
    total_chunks = 0

    biosppy_total, neurokit2_total = count_progress_units(grouped_entries, analysis_manifest)
    progress = AnalysisProgressTracker(biosppy_total, neurokit2_total)
    progress.mark_data_prepared()

    signal_kind_counts: Dict[str, int] = {}

    for segment_index, segment_files in grouped_entries.items():
        segment_result = process_segment(
            segment_index,
            analysis_manifest,
            sample_rate,
            segment_files,
            output_folder,
            eda_method,
            progress=progress,
        )

        for channel in segment_result.get("channels", []):
            if isinstance(channel, dict):
                signal_kind = channel.get("signalKind", "generic")
                signal_kind_counts[signal_kind] = signal_kind_counts.get(signal_kind, 0) + 1

        segment_results.append(segment_result)
        total_frames += int(segment_result.get("frameCount", 0) or 0)
        total_chunks += len(segment_files)

    biosppy_strategy = ["ecg", "eda", "ppg", "emg", "rsp", "eeg", "pcg", "acc"]

    return {
        "sessionId": manifest.get("sessionId"),
        "sessionFolder": str(session_folder),
        "chunkCount": total_chunks,
        "analyzedAt": now_iso(),
        "completedAt": now_iso(),
        "worker": {
            "name": "python-analysis-worker",
            "biosppyAvailable": process_biosppy_signal is not None,
            "neurokit2Available": nk is not None,
            "libraryStrategy": {
                "biosppy": biosppy_strategy,
                "neurokit2": ["ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg", "hrv"],
            },
        },
        "analysisConfig": {
            "batchMode": "load-session-process-entire-dataset-store-features",
            "channelSignalKinds": analysis_manifest.get("channelSignalKinds", {}),
            "channelSignalAxes": analysis_manifest.get("channelSignalAxes", {}),
            "signalKindOverrides": selected_signal_kinds,
            "signalAxisOverrides": selected_signal_axes,
            "edaMethod": eda_method or "neurokit2-default",
        },
        "segments": segment_results,
        "warnings": [],
    }, progress


def write_summary_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "summary.csv"
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
                if not isinstance(channel, dict):
                    continue

                summary = channel.get("summary", {})
                analysis = channel.get("analysis", {})
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



def write_features_csv(output_folder: Path, result: Dict[str, Any]) -> None:
    csv_path = output_folder / "features.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["segment", "channel", "label", "signalKind", "library", "feature", "value"])

        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            channels = segment.get("channels", []) if isinstance(segment, dict) else []
            for channel in channels:
                if not isinstance(channel, dict):
                    continue

                analysis = channel.get("analysis", {})
                if not isinstance(analysis, dict):
                    continue

                for library, feature_key in [("biosppy", "biosppyFeatures"), ("neurokit2", "neurokit2Features")]:
                    features = analysis.get(feature_key, {})
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
                                library,
                                feature_name,
                                serialized,
                            ]
                        )


def append_features_readme_section(output_folder: Path) -> None:
    """Append a human-readable 'Features extracted' section to README.md describing
    the features present in `features.csv` grouped by library. Uses a small
    mapping for well-known keys and conservative fallbacks for unknown names.
    """
    features_path = output_folder / "features.csv"
    readme_path = output_folder / "README.md"
    if not features_path.exists():
        return

    # Collect features per library
    libs: Dict[str, set] = {}
    try:
        with features_path.open("r", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            header = next(reader, None)
            for row in reader:
                if len(row) < 6:
                    continue
                lib = row[4] or "unknown"
                feat = row[5] or ""
                libs.setdefault(lib, set()).add(feat)
    except Exception:
        return

    # Known feature descriptions (concise)
    known: Dict[str, str] = {
        # NeuroKit2 HRV metrics (common)
        "HRV_RMSSD": "Root Mean Square of Successive Differences of RR intervals (ms) - short-term HRV.",
        "HRV_SDNN": "Standard deviation of NN intervals (ms) - HRV overall variability.",
        "HRV_LF": "Low-frequency spectral power (Hz) component of HRV.",
        "HRV_HF": "High-frequency spectral power (Hz) component of HRV.",
        "HRV_LFHF": "Ratio of LF to HF power - balance of autonomic tone.",
        "HRV_PAS": "Probability-based or pseudospectral HRV metric (library-specific); consult NeuroKit2 docs for exact definition.",

        # BioSPPy / signal-level
        "filtered_mean": "Mean of the filtered signal (post-processing).",
        "filtered_std": "Standard deviation of the filtered signal.",
        "filtered_max": "Maximum value in the filtered signal.",
        "filtered_min": "Minimum value in the filtered signal.",
        "filtered_count": "Number of samples in the filtered signal.",
        "heart_rate_mean": "Average heart rate (beats per minute).",
        "heart_rate_max": "Maximum heart rate observed (BPM).",
        "heart_rate_min": "Minimum heart rate observed (BPM).",
        "rpeaks_count": "Number of detected R-peaks in the ECG signal.",
    }

    def describe(feature: str, lib: str) -> str:
        if feature in known:
            return known[feature]
        # Prefix-based fallbacks
        if feature.startswith("HRV_"):
            return f"{feature}: heart-rate-variability derived metric (NeuroKit2). See NeuroKit2.hrv docs."
        if feature.startswith("ECG_") or feature.startswith("ECG"):
            return f"{feature}: ECG-derived timing or peaks-related value (NeuroKit2)."
        if feature.startswith("templates_") or feature.startswith("ts_"):
            return f"{feature}: time-series summary statistic or template timing (library-specific)."
        if feature.startswith("HRV_"):
            return f"{feature}: HRV metric (NeuroKit2)."
        if feature:
            return f"{feature}: feature generated by {lib}; consult the library docs for details."
        return "Unnamed feature"

    lines: List[str] = []
    lines.append("## Features extracted by analysis\n")
    lines.append("This section lists the features written to `features.csv` during analysis, grouped by the library that produced them. Short descriptions are provided where available.\n")

    for lib, feats in sorted(libs.items()):
        lines.append(f"### {lib}\n")
        for feat in sorted(feats):
            desc = describe(feat, lib)
            lines.append(f"- **{feat}**: {desc}\n")
        lines.append("\n")

    try:
        # Append to README (create if missing)
        with readme_path.open("a", encoding="utf-8") as rh:
            rh.write("\n".join(lines))
    except Exception:
        # Non-fatal: don't break analysis if README append fails
        pass

def write_channel_series_csvs(output_folder: Path, result: Dict[str, Any]) -> None:
    """Write per-channel CSVs from stashed series data collected during analysis.

    This consumes `_indices`, `_values`, and `_export_name` fields produced by
    `analyze_channel`, writes CSVs per-segment/channel, and sets `seriesPath`
    on each channel record. Temporary fields are removed after writing to
    avoid bloating the JSON result.
    """
    sample_rate = result.get("sampleRate") or 0
    for segment in result.get("segments", []):
        segment_index = segment.get("segment") if isinstance(segment, dict) else None
        segment_folder = output_folder / f"segment-{segment_index}"
        segment_folder.mkdir(parents=True, exist_ok=True)

        for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
            if not isinstance(channel, dict):
                continue

            if "_indices" in channel and "_values" in channel:
                export_name = channel.get("_export_name") or channel.get("channel")
                series_path = export_series_csv(
                    segment_folder,
                    export_name,
                    channel["_indices"],
                    channel["_values"],
                    sample_rate,
                )
                channel["seriesPath"] = series_path
                for tmp in ("_indices", "_values", "_export_name"):
                    if tmp in channel:
                        del channel[tmp]

# --- ScientISST sense.py FileWriter-format export ---------------------------

def _sense_num(value: Any) -> Union[int, float]:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return 0
        return int(value) if value.is_integer() else value
    coerced = safe_float(value)
    if coerced is None:
        return 0
    return int(coerced) if coerced.is_integer() else coerced


def _sense_channel_number(channel_key: Any, fallback: int) -> int:
    match = re.match(r"^A([IX])(\d+)$", str(channel_key).strip(), re.IGNORECASE)
    if match:
        try:
            number = int(match.group(2))
        except ValueError:
            return fallback
        # AX1/AX2 are channels 7/8 in the ScientISST API.
        if match.group(1).upper() == "X":
            return 6 + number if 1 <= number <= 2 else number
        return number
    return fallback


def write_signal_csvs(
    output_folder: Path,
    session_folder: Path,
    result: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Re-emit each segment's acquired frames as a CSV in the canonical
    ScientISST `sense.py` FileWriter layout in `mv=False` mode (see the
    SENSE_FILEWRITER_* notes above and sense_src/file_writer.py /
    scientisst/frame.py upstream):

        #{'API version': ..., 'Channels': [...], 'Channels indexes': [...],
          'Channels labels': [...], 'Device': ..., 'Firmware version': ...,
          'Header': [...], 'ISO 8601': ..., 'Resolution (bits)': [...],
          'Sampling rate (Hz)': ..., 'Timestamp': ...}
        #NSeq<TAB>I1<TAB>I2<TAB>O1<TAB>O2<TAB>AI1<TAB>AI2<TAB>...
        <NSeq><TAB>0<TAB>0<TAB>0<TAB>0<TAB><AI1 raw><TAB><AI2 raw><TAB>...

    One file per segment, written to ``<output>/segment-<N>/signal.csv`` with LF
    line endings (as FileWriter does on its native platform). Digital ports
    I1/I2/O1/O2 are emitted as 0, the desktop pipeline does not retain them.
    Returns the list of written paths.
    """
    try:
        manifest = load_session_manifest(session_folder)
    except Exception:
        return []

    try:
        chunk_entries = discover_chunk_entries(session_folder, manifest)
    except Exception:
        chunk_entries = []
    if not chunk_entries:
        return []
    grouped = group_entries_by_segment(chunk_entries)

    sample_rate: Any = manifest.get("sampleRate")
    if sample_rate is None:
        sample_rate = manifest.get("samplingRate")
    if sample_rate is None and isinstance(result, dict):
        sample_rate = result.get("sampleRate")
    sr_value = safe_float(sample_rate)
    if sr_value is None:
        sample_rate_field: Union[int, float] = 0
    else:
        sample_rate_field = int(sr_value) if sr_value.is_integer() else sr_value

    # Prefer an explicit top-level `device` label (set by the app) for the
    # Device metadata. Fall back to csvHeader.Device, then to deviceType
    # labels.
    device_field = None
    if isinstance(manifest.get("device"), str) and manifest.get("device").strip():
        device_field = manifest.get("device").strip()
    else:
        csv_header = manifest.get("csvHeader")
        if isinstance(csv_header, dict) and isinstance(csv_header.get("Device"), str) and csv_header["Device"].strip():
            device_field = csv_header["Device"].strip()

    if not device_field:
        if manifest.get("deviceType") == "maker":
            device_field = "Maker"
        elif manifest.get("deviceType") == "sense":
            device_field = "ScientISST Sense"
        else:
            device_field = "ScientISST"
    else:
        # The app already normalizes the friendly name; ensure it's a string and trim whitespace.
        device_field = str(device_field).strip()

    api_version = manifest.get("apiVersion")
    api_version_field = api_version.strip() if isinstance(api_version, str) and api_version.strip() else SENSE_FILEWRITER_API_VERSION
    firmware = manifest.get("firmwareVersion")
    firmware_field = firmware if isinstance(firmware, str) else ""

    segment_start_ms: Dict[int, Any] = {}
    raw_segments = manifest.get("segments")
    if isinstance(raw_segments, list):
        for seg in raw_segments:
            if isinstance(seg, dict) and "index" in seg:
                try:
                    segment_start_ms[int(seg["index"])] = seg.get("startedAt")
                except (TypeError, ValueError):
                    pass

    manifest_channels = manifest.get("channels")
    written: List[str] = []

    for segment_index, chunk_files in grouped.items():
        channel_keys: List[str] = []
        if isinstance(manifest_channels, list):
            channel_keys = [str(c).strip() for c in manifest_channels if isinstance(c, (str, int)) and str(c).strip()]
        if not channel_keys:
            for chunk_file in chunk_files:
                for frame in load_chunk_frames(Path(chunk_file)):
                    keys = list(frame_channels(frame).keys())
                    if keys:
                        channel_keys = sorted(keys)
                        break
                if channel_keys:
                    break
        if not channel_keys:
            continue

        channel_numbers = [_sense_channel_number(key, idx + 1) for idx, key in enumerate(channel_keys)]
        # sense.py mv=False mode: one raw column per channel.
        channel_labels: List[str] = []
        for number in channel_numbers:
            prefix = "AX" if number in (7, 8) else "AI"
            channel_labels.append(f"{prefix}{number}_raw")
        header_columns = ["#NSeq", "I1", "I2", "O1", "O2"] + channel_labels
        channel_resolutions = [
            int(SENSE_CHANNEL_RESOLUTION_BITS.get(str(key), SENSE_DEFAULT_CHANNEL_RESOLUTION_BITS))
            for key in channel_keys
        ]

        started_ms = segment_start_ms.get(segment_index)
        if started_ms is None:
            started_ms = manifest.get("startedAt")
        ts_seconds = safe_float(started_ms)
        ts_seconds = ts_seconds / 1000.0 if ts_seconds is not None else time.time()
        try:
            iso_field = datetime.fromtimestamp(ts_seconds).isoformat()
        except (OverflowError, OSError, ValueError):
            now = datetime.now()
            iso_field = now.isoformat()
            ts_seconds = now.timestamp()

        metadata = {
            "API version": api_version_field,
            "Channels": [int(n) for n in channel_numbers],
            "Channels indexes": [(n - 1) + 5 for n in channel_numbers],
            "Channels labels": channel_labels,
            "Device": device_field,
            "Firmware version": firmware_field,
            "Header": header_columns,
            "ISO 8601": iso_field,
            "Resolution (bits)": [12, 1, 1, 1, 1] + channel_resolutions,
            "Sampling rate (Hz)": sample_rate_field,
            "Timestamp": float(ts_seconds),
        }
        metadata = {key: metadata[key] for key in sorted(metadata)}

        segment_folder = output_folder / f"segment-{segment_index}"
        segment_folder.mkdir(parents=True, exist_ok=True)
        csv_path = segment_folder / "signal.csv"

        digital_prefix = ["0", "0", "0", "0"]  # I1, I2, O1, O2 — not retained by the pipeline
        running_index = 0

        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write("#{}\n".format(metadata))
            handle.write("{}\n".format("\t".join(header_columns)))
            for chunk_file in chunk_files:
                lines: List[str] = []
                for frame in load_chunk_frames(Path(chunk_file)):
                    seq_raw = frame.get("sequence")
                    if seq_raw is None:
                        seq_raw = frame.get("__seq")
                    if isinstance(seq_raw, bool) or not isinstance(seq_raw, (int, float)) or (
                        isinstance(seq_raw, float) and not math.isfinite(seq_raw)
                    ):
                        seq_val = running_index
                    else:
                        seq_val = int(seq_raw)
                    running_index += 1
                    channels_dict = frame_channels(frame)
                    row = [str(seq_val)] + digital_prefix
                    for key in channel_keys:
                        raw_value = _sense_num(channels_dict.get(key))
                        row.append(str(raw_value))
                    lines.append("\t".join(row))
                if lines:
                    handle.write("\n".join(lines) + "\n")

        written.append(str(csv_path))
        if isinstance(result, dict) and isinstance(result.get("segments"), list):
            for seg in result["segments"]:
                if isinstance(seg, dict) and seg.get("segment") == segment_index:
                    seg["signalCsv"] = str(csv_path)
                    break

    return written


def main() -> int:
    args = parse_args()
    session_folder = Path(args.session_folder).resolve()
    output_folder = Path(args.output_folder).resolve()
    output_folder.mkdir(parents=True, exist_ok=True)

    try:
        session_name = session_folder.name
        analysis_started = time.perf_counter()
        result, progress = build_result(
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
        progress.emit("Writing output files", force=True)

        write_channel_series_csvs(output_folder, result)

        try:
            signal_csvs = write_signal_csvs(output_folder, session_folder, result)
            if signal_csvs:
                print(
                    f"[analysis][{session_name}] wrote {len(signal_csvs)} sense.py-format signal CSV(s)",
                    flush=True,
                )
        except Exception as exc:  
            print(
                f"[analysis][{session_name}] WARNING: could not write sense.py-format signal CSV(s): {exc}",
                flush=True,
            )

        try:
            readme_path = output_folder / "README.md"
            with readme_path.open("w", encoding="utf-8") as rhandle:
                rhandle.write(
                    """# Analysis output

This folder contains CSV summaries, per-channel series, and a raw-signal
export for the session.

- `summary.csv`: per-segment, per-channel summary statistics.
- `features.csv`: flattened feature table with a `library` column (biosppy/neurokit2).
- `segment-<N>/channels/`: per-channel time series CSVs named `CHANNEL_KIND.csv` (e.g. `AI1_ECG.csv`).
- `segment-<N>/signal.csv`: the segment's acquired frames in the ScientISST
`sense.py` FileWriter layout (`mv=False` mode) — a `#{...}` Python-dict
metadata line, a tab-separated `#NSeq I1 I2 O1 O2 AI1_raw AI2_raw ...`
column header, then one tab-separated row per frame — so it loads like a
recording produced by the sense.py CLI
(github.com/scientisst/scientisst-sense-api-python).

Notes:
- In `signal.csv` the digital ports I1/I2/O1/O2 are written as 0 (the desktop
pipeline does not retain them); only raw ADC samples are emitted.
- The worker defers writing of large per-channel and signal CSVs until the
output phase so the reported "analysis" time measures signal processing only;
CSV export is performed after analysis completes.
                    """
                )
        except Exception:
            pass

        result = prune_bulky_arrays(result)
        result = sanitize_for_json(result)
        result_path = output_folder / "analysis.json"
        write_summary_csv(output_folder, result)
        write_features_csv(output_folder, result)
        try:
            append_features_readme_section(output_folder)
        except Exception:
            pass
        with result_path.open("w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2, ensure_ascii=False, allow_nan=False)
        progress.mark_csv_written()
        total_seconds = time.perf_counter() - analysis_started
        if result_path.stat().st_size / (1024*1024) > 0.1:
            result_size_mb = result_path.stat().st_size / (1024*1024) 
            print(
                f"[{session_name}] done in {total_seconds:.2f}s "
                f"(analysis {analyze_seconds:.2f}s + outputs {total_seconds - analyze_seconds:.2f}s) "
                f"— {chunk_count} chunks, {frame_count} frames"
                f"{sample_rate_suffix} (eda_method={args.eda_method}, "
                f"result.json={result_size_mb:.1f}MB)",
                flush=True,
            )
        else:
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
