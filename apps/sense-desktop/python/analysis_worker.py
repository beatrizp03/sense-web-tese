#!/usr/bin/env python3
"""Post-hoc analysis worker for SENSE Desktop.

Input:
  --session-folder  Folder that contains session.json and chunk files
  --output-folder   Folder where analysis artifacts should be written

Output:
  Writes analysis-result.json, analysis-summary.csv, analysis-biosppy-features.csv,
  and per-channel series CSVs under output-folder.

Windowing Strategy:
  - Full-length analysis: Most signals (ECG, EDA, PPG, EMG, RSP, EOG, EEG, ACC)
    are analyzed in their entirety for maximum statistical defensibility.
  - PCG windowing: PCG signals are segmented into non-overlapping time windows
    (default 60s) due to O(n²) correlation cost in BioSPPy's get_avg_heart_rate()
    implementation. This is a computational limitation of the underlying library,
    not a methodological choice. Per-window results are aggregated into a
    segment-level summary. If BioSPPy adopts FFT-based correlation in the future,
    this workaround can be removed without rethinking the analysis approach.
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

# PCG window size: 60s due to O(n²) correlation bottleneck in BioSPPy.get_avg_heart_rate()
PCG_WINDOW_SECONDS = 60


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run post-hoc signal analysis for a SENSE session")
    parser.add_argument("--session-folder", required=True, help="Path to a session folder")
    parser.add_argument("--output-folder", required=True, help="Path to the analysis output folder")
    # NeuroKit2's eda_process supports "neurokit" or "biosppy" as cleaning
    # methods. cvxEDA is a phasic-decomposition method (used by eda_phasic),
    # not a cleaning method, and passing it to eda_process raises ValueError.
    # We default to "neurokit"; cvxEDA support is reserved as a future
    # extension via a separate eda_phasic stage.
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


def slice_signal_into_windows(
    values: Sequence[float],
    indices: Sequence[int],
    sample_rate: float,
    window_seconds: int,
) -> List[Tuple[List[int], List[float]]]:
    """Slice a channel signal into non-overlapping time windows.

    Returns list of (indices, values) tuples, one per window.
    Last window may be shorter if signal length doesn't divide evenly.
    """
    window_samples = int(window_seconds * sample_rate)
    windows: List[Tuple[List[int], List[float]]] = []

    for start_idx in range(0, len(values), window_samples):
        end_idx = min(start_idx + window_samples, len(values))
        window_indices = list(indices[start_idx:end_idx])
        window_values = list(values[start_idx:end_idx])
        if len(window_values) > 0:
            windows.append((window_indices, window_values))

    return windows


def aggregate_window_stats(window_stats: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate per-window statistics into segment-level summary."""
    if not window_stats:
        return {"count": 0, "mean": None, "std": None, "min": None, "max": None}

    all_counts = [s.get("count", 0) for s in window_stats if s.get("count")]
    all_means = [s.get("mean") for s in window_stats if s.get("mean") is not None]
    all_stds = [s.get("std") for s in window_stats if s.get("std") is not None]
    all_mins = [s.get("min") for s in window_stats if s.get("min") is not None]
    all_maxs = [s.get("max") for s in window_stats if s.get("max") is not None]

    total_count = sum(all_counts)

    # Per-window means are independent samples; aggregate by weighted average
    if all_means and total_count > 0:
        segment_mean = sum(s.get("mean", 0) * s.get("count", 1) for s in window_stats) / total_count
    else:
        segment_mean = None

    # Std and min/max across windows
    if len(all_stds) > 1:
        segment_std = pstdev(all_stds)
    elif all_stds:
        segment_std = all_stds[0]
    else:
        segment_std = None
    segment_min = min(all_mins) if all_mins else None
    segment_max = max(all_maxs) if all_maxs else None

    return {
        "count": total_count,
        "mean": segment_mean,
        "std": segment_std,
        "min": segment_min,
        "max": segment_max,
    }


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
        for channel_key in channels:
            normalized_kind = (infer_signal_kind(manifest, channel_key) or "").lower()
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
    indices_list: List[tuple],
    sample_rate: float,
) -> str:
    """Export multiple signal segments (e.g., PCG windows) to a single CSV.

    Args:
        output_folder: Output directory for the CSV.
        channel_name: Human-readable channel name (e.g., 'PCG', 'ECG').
        indices_list: List of (indices, values, window_index) tuples.
                      For non-windowed channels, pass [(indices, values, 0)].
        sample_rate: Sampling rate in Hz.

    Returns:
        Path to the written CSV file.
    """
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in channel_name
    ).strip("_") or "channel"
    series_dir = output_folder / "channels"
    series_dir.mkdir(parents=True, exist_ok=True)
    csv_path = series_dir / f"{safe_name}.csv"

    # If NumPy is available, write segment-by-segment to cap memory usage
    header = "index,time_seconds,value,window_index\n"
    if not indices_list:
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write(header)
        return str(csv_path)

    if np is not None:
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            handle.write(header)
            for indices, values, window_index in indices_list:
                idx_arr = np.asarray(indices, dtype=np.int64)
                val_arr = np.asarray(values, dtype=np.float64)
                win_arr = np.full(idx_arr.shape, window_index, dtype=np.int32)
                time_arr = (idx_arr / sample_rate) if sample_rate else idx_arr.astype(np.float64)
                stacked = np.column_stack([idx_arr, time_arr, val_arr, win_arr])
                np.savetxt(
                    handle,
                    stacked,
                    delimiter=",",
                    fmt=["%d", "%.9g", "%.9g", "%d"],
                )
        return str(csv_path)

    # Fallback: no NumPy available, write with csv.writer (least efficient).
    # Note: in typical deployments NumPy is imported at module load and used
    # elsewhere in this worker, so this path is effectively unreachable unless
    # someone manually disables or removes NumPy. Keep it as defensive code
    # for minimal environments.
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["index", "time_seconds", "value", "window_index"])
        for indices, values, window_index in indices_list:
            for index, value in zip(indices, values):
                writer.writerow([index, index / sample_rate if sample_rate else index, value, window_index])

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

PROGRESS_STAGE_WEIGHTS = {
    "data_prep": 5.0,
    "biosppy": 60.0,
    "neurokit2": 30.0,
    "csv": 5.0,
}

BIOSPPY_PROGRESS_SIGNAL_KINDS = {"ecg", "eda", "ppg", "emg", "rsp", "eeg", "pcg", "acc"}
NEUROKIT2_PROGRESS_SIGNAL_KINDS = {"ecg", "eda", "ppg", "emg", "rsp", "eog"}


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

    def start_biosppy_analysis(self) -> None:
        """Emit initialization message for BioSPPy analysis phase."""
        if not self.biosppy_started and self.biosppy_total > 0:
            self.biosppy_started = True
            self.emit("Initializing BioSPPy analysis", force=True)

    def start_neurokit2_analysis(self) -> None:
        """Emit initialization message for NeuroKit2 analysis phase."""
        if not self.neurokit2_started and self.neurokit2_total > 0:
            self.neurokit2_started = True
            self.emit("Initializing NeuroKit2 analysis", force=True)

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
                # Most NeuroKit2 features arrive as event arrays (SCR onsets,
                # EOG blinks, R-peaks, ...). Summarize the numeric ones the same
                # way the BioSPPy extractor does so they survive into the CSV.
                numeric_values = [item for item in value if _is_finite_number(item)]
                if numeric_values:
                    stats = basic_stats(numeric_values)
                    for stat_name, stat_value in stats.items():
                        features[f"{key}_{stat_name}"] = stat_value
                # Non-numeric arrays (string labels, nested structures) are
                # skipped, as before.

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

    # Domain-specific features computed by an analyze_* function (e.g. EOG blink
    # rate, inter-blink intervals) are stashed here so they reach the CSV. They
    # take precedence over the mechanically-extracted summaries above.
    derived = nk_block.get("derivedFeatures")
    if isinstance(derived, dict):
        for key, value in derived.items():
            if _is_finite_number(value):
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
            # If an override is provided, try to use it. Fall back to the
            # default call if the installed neurokit2 doesn't accept the
            # 'method' argument (TypeError) or rejects the value (ValueError,
            # e.g. a phasic-decomposition method like cvxEDA passed here).
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


def _extract_eog_features(signals: Any, info: Any, sample_rate: float) -> Dict[str, Any]:
    """Derive domain-specific EOG features from NeuroKit2's eog_process output:
    blink count, blink rate per minute, inter-blink-interval stats, and stats of
    the per-sample blink-rate signal.

    NeuroKit2 has shuffled EOG key/column names across versions (EOG_Blinks vs
    EOG_Onsets in `info`; EOG_Rate vs EOG_Rate_Mean in `signals`), so lookups
    probe a few candidates rather than assuming one name. Everything is wrapped
    so a missing key/column/library degrades to "no feature" instead of raising.
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


def analyze_eog(values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "eog", "libraries": []}
    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    if nk is not None:
        try:
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
    window_index: Optional[int] = None,
    progress: Optional[AnalysisProgressTracker] = None,
    counts_as_full_channel: bool = True,
    export_series: bool = True,
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

    # Defer CSV export: always stash raw series for the output phase to write.
    # This keeps the "analysis" phase timing focused on signal processing
    # and moves I/O to the output phase.
    record["_indices"] = indices
    record["_values"] = values
    record["_window_index"] = window_index if window_index is not None else 0
    record["_export_name"] = f"{channel_key}_{normalized_kind.upper()}" if normalized_kind else channel_key

    if window_index is not None:
        record["windowIndex"] = window_index

    if not values:
        record["warnings"] = ["No numeric samples found for channel"]
        if progress is not None:
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS:
                progress.advance_biosppy(1, f"BioSPPy: {normalized_kind.upper()} ({label})")
            if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                progress.advance_neurokit2(1, f"NeuroKit2: {normalized_kind.upper()} ({label})")
        return record

    # Emit sub-progress stages during channel analysis for visual feedback
    # Each channel is divided into 4 work units: filtering (0.25), peaks (0.5), neurokit2 (0.2), complete (0.05)
    has_biosppy = progress is not None and counts_as_full_channel and normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS and normalized_kind != "pcg"
    has_neurokit2 = progress is not None and counts_as_full_channel and normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS
    
    if has_biosppy:
        progress.advance_biosppy(0.25, f"BioSPPy {normalized_kind.upper()} ({label}): filtering & segmentation")

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

    if has_biosppy:
        progress.advance_biosppy(0.5, f"BioSPPy {normalized_kind.upper()} ({label}): detecting peaks & features")

    analysis_record = record.get("analysis")
    if isinstance(analysis_record, dict):
        extract_neurokit2_features(analysis_record)

    if has_neurokit2:
        progress.advance_neurokit2(0.2, f"NeuroKit2 {normalized_kind.upper()} ({label}): processing & HRV")

    if progress is not None and counts_as_full_channel:
        if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS and normalized_kind != "pcg":
            progress.advance_biosppy(0.25, f"BioSPPy: {normalized_kind.upper()} ({label})")
        if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
            progress.advance_neurokit2(0.8, f"NeuroKit2: {normalized_kind.upper()} ({label})")

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
    for channel_key in channels:
        label = infer_label(channel_key, manifest)
        kind = infer_signal_kind(manifest, channel_key)
        
        # Emit phase initialization before processing signals of each type
        if progress is not None:
            normalized_kind = (kind or "").lower()
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS:
                progress.start_biosppy_analysis()
            if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                progress.start_neurokit2_analysis()
        
        indices, values = channel_series(frames, channel_key)

        if not values:
            # No valid data for channel
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

        # PCG segmentation: O(n²) correlation bottleneck in BioSPPy get_avg_heart_rate()
        # This is a computational limitation of the underlying library, not a methodological choice.
        # Window size: PCG_WINDOW_SECONDS (60s).
        # If BioSPPy adopts FFT-based correlation, windowing can be removed.
        if (kind or "").lower() == "pcg":
            windows = slice_signal_into_windows(values, indices, sample_rate, PCG_WINDOW_SECONDS)

            if not windows:
                result_channels.append({
                    "channel": channel_key,
                    "label": label,
                    "signalKind": kind or "generic",
                    "summary": {"count": 0, "mean": None, "std": None, "min": None, "max": None},
                    "warnings": ["Channel contains no valid samples"],
                })
                if progress is not None:
                    progress.advance_biosppy(1, f"BioSPPy: PCG ({label})")
                continue

            # Analyze each window
            windowed_results = []
            all_stats = []
            window_segments = []  # Collect (indices, values, window_index) tuples for batch export
            for window_idx, (window_indices, window_values) in enumerate(windows):
                window_result = analyze_channel(
                    channel_key=channel_key,
                    label=label,
                    kind=kind,
                    values=window_values,
                    sample_rate=sample_rate,
                    indices=window_indices,
                    output_folder=output_folder / f"segment-{segment_index}",
                    eda_method=eda_method,
                    window_index=window_idx,
                    progress=progress,
                    counts_as_full_channel=False,
                    export_series=False,  # Don't export per-window; we'll batch export after
                )
                windowed_results.append(window_result)
                all_stats.append(window_result.get("summary", {}))
                window_segments.append((window_indices, window_values, window_idx))

                if progress is not None:
                    progress.advance_biosppy(
                        1.0 / len(windows),
                        f"BioSPPy: PCG ({label}) window {window_idx + 1}/{len(windows)}",
                    )

            # Aggregate statistics across windows for top-level summary
            aggregated_summary = aggregate_window_stats(all_stats)

            # Build final channel record for PCG
            channel_record = {
                "channel": channel_key,
                "label": label,
                "signalKind": kind or "generic",
                "summary": aggregated_summary,
                "windows": windowed_results,
            }
            
        else:
            # Full-length analysis for non-PCG signals
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
            # Preserve all fields returned by analyze_channel so deferred-export
            # temp fields (e.g. `_indices`, `_values`, `_export_name`) survive
            # into the output phase. Override identifying fields explicitly.
            channel_record = dict(channel_result)
            channel_record["channel"] = channel_key
            channel_record["label"] = label
            channel_record["signalKind"] = kind or "generic"

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
    analysis_manifest = dict(manifest)
    analysis_manifest["channelSignalKinds"] = merge_signal_kind_maps(manifest, selected_signal_kinds)

    grouped_entries = group_entries_by_segment(chunk_entries)
    segment_results: List[Dict[str, Any]] = []
    total_frames = 0
    total_chunks = 0

    # Pre-count actual analysis work so progress reflects the real channel mix.
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

        # Track progress by signal kind
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
            "windowConfig": {
                "pcg": PCG_WINDOW_SECONDS,
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
                "window_index",
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

                # Check if channel has windowed results
                windows = channel.get("windows", [])
                if windows:
                    # New schema with windows
                    for window_record in windows:
                        if not isinstance(window_record, dict):
                            continue
                        summary = window_record.get("summary", {})
                        analysis = window_record.get("analysis", {})
                        writer.writerow(
                            [
                                segment_index,
                                channel.get("channel"),
                                channel.get("label"),
                                channel.get("signalKind"),
                                window_record.get("windowIndex", ""),
                                summary.get("count"),
                                summary.get("mean"),
                                summary.get("std"),
                                summary.get("min"),
                                summary.get("max"),
                                ",".join(analysis.get("libraries", []))
                                if isinstance(analysis.get("libraries"), list)
                                else "",
                                window_record.get("seriesPath"),
                            ]
                        )
                else:
                    # Fallback to old schema (channel-level analysis)
                    summary = channel.get("summary", {})
                    analysis = channel.get("analysis", {})
                    writer.writerow(
                        [
                            segment_index,
                            channel.get("channel"),
                            channel.get("label"),
                            channel.get("signalKind"),
                            "",  # No window index in old schema
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
        writer.writerow(["segment", "channel", "label", "signalKind", "window_index", "library", "feature", "value"])

        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            channels = segment.get("channels", []) if isinstance(segment, dict) else []
            for channel in channels:
                if not isinstance(channel, dict):
                    continue

                # Check if channel has windowed results
                windows = channel.get("windows", [])
                if windows:
                    # New schema with windows
                    for window_record in windows:
                        if not isinstance(window_record, dict):
                            continue
                        analysis = window_record.get("analysis", {})
                        if not isinstance(analysis, dict):
                            continue

                        # Iterate both biosppy and neurokit2 features
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
                                        window_record.get("windowIndex", 0),
                                        library,
                                        feature_name,
                                        serialized,
                                    ]
                                )
                else:
                    # Fallback to old schema (channel-level analysis)
                    analysis = channel.get("analysis", {})
                    if not isinstance(analysis, dict):
                        continue

                    # Iterate both biosppy and neurokit2 features
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
                                    0,  # No window index in old schema; use 0 for consistency
                                    library,
                                    feature_name,
                                    serialized,
                                ]
                            )



def write_channel_series_csvs(output_folder: Path, result: Dict[str, Any]) -> None:
    """Write per-channel CSVs from stashed series data collected during analysis.

    This consumes `_indices`, `_values`, `_window_index`, and `_export_name`
    fields produced by `analyze_channel`, writes CSVs per-segment/channel, and
    sets `seriesPath` on the channel/window records. Temporary fields are
    removed after writing to avoid bloating the JSON result.
    """
    sample_rate = result.get("sampleRate") or 0
    for segment in result.get("segments", []):
        segment_index = segment.get("segment") if isinstance(segment, dict) else None
        segment_folder = output_folder / f"segment-{segment_index}"
        # Ensure segment folder exists; export_series_csv will create channels/ as needed.
        segment_folder.mkdir(parents=True, exist_ok=True)

        for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
            if not isinstance(channel, dict):
                continue

            windows = channel.get("windows", [])
            if windows:
                indices_list = []
                export_name = None
                for window_record in windows:
                    if not isinstance(window_record, dict):
                        continue
                    if "_indices" in window_record and "_values" in window_record:
                        indices_list.append((window_record["_indices"], window_record["_values"], window_record.get("_window_index", window_record.get("windowIndex", 0))))
                        if export_name is None:
                            export_name = window_record.get("_export_name")

                if indices_list:
                    series_path = export_series_csv(segment_folder, export_name or channel.get("channel"), indices_list, sample_rate)
                    for window_record in windows:
                        if not isinstance(window_record, dict):
                            continue
                        window_record["seriesPath"] = series_path
                        # Remove temp fields
                        for tmp in ("_indices", "_values", "_window_index", "_export_name"):
                            if tmp in window_record:
                                del window_record[tmp]

            else:
                # Channel-level series
                if "_indices" in channel and "_values" in channel:
                    export_name = channel.get("_export_name") or channel.get("channel")
                    series_path = export_series_csv(segment_folder, export_name, [(channel["_indices"], channel["_values"], channel.get("_window_index", 0))], sample_rate)
                    channel["seriesPath"] = series_path
                    for tmp in ("_indices", "_values", "_window_index", "_export_name"):
                        if tmp in channel:
                            del channel[tmp]



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

        # Write per-channel series CSVs that were deferred during analysis.
        # This moves I/O out of the timed analysis phase into the output phase.
        write_channel_series_csvs(output_folder, result)

        # Write a small README describing the output layout and important notes.
        try:
            readme_path = output_folder / "README.md"
            with readme_path.open("w", encoding="utf-8") as rhandle:
                rhandle.write(
                    """# Analysis output

                        This folder contains CSV summaries and per-channel series for the session.

                        - `summary.csv`: per-segment and per-window summary statistics.
                        - `features.csv`: flattened feature table with a `library` column (biosppy/neurokit2).
                        - `channels/`: per-channel time series CSVs named `CHANNEL_KIND.csv` (e.g. `AI1_ECG.csv`).

                        Notes:
                        - PCG signals are analyzed in fixed-size windows; all windows for a given
                        segment/channel are exported into a single CSV file. Each row contains a
                        `window_index` column so rows can be associated with their originating window.
                        As a consequence, the `seriesPath` on each window record points to the same
                        consolidated CSV for that channel.
                        - The worker defers writing of large per-channel CSVs until the output phase so
                        the reported "analysis" time measures signal processing only; CSV export is
                        performed after analysis completes.
                    """
                )
        except Exception:
            # README is a convenience; failures here should not abort the job.
            pass

        # Drop sample-length arrays from biosppy/neurokit2 payloads (duplicates
        # of the per-channel CSV exports), then replace NaN/Inf with None so
        # the Electron renderer's strict JSON.parse can read it.
        result = prune_bulky_arrays(result)
        result = sanitize_for_json(result)
        result_path = output_folder / "analysis.json"
        write_summary_csv(output_folder, result)
        write_features_csv(output_folder, result)
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
