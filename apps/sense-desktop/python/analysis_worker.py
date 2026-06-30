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
from statistics import mean, pstdev, median
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from analysis_logger import AnalysisLogger

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

try:
    from preprocessing_metadata import (
        build_preprocessing_block,
        get_preprocessing_metadata,
    )
except Exception:
    build_preprocessing_block = None
    get_preprocessing_metadata = None

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
PRIMARY_LIBRARY = "biosppy"
SECONDARY_LIBRARY = "neurokit2"

SIGNAL_LIBRARY_POLICY: Dict[str, Dict[str, Any]] = {
    "ecg": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "eda": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "ppg": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "emg": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "rsp": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "eeg": {"primary": PRIMARY_LIBRARY, "secondary": [SECONDARY_LIBRARY]},
    "pcg": {"primary": PRIMARY_LIBRARY, "secondary": []},
    "acc": {"primary": PRIMARY_LIBRARY, "secondary": []},
    "eog": {"primary": SECONDARY_LIBRARY, "secondary": []},
    "hrv": {"primary": SECONDARY_LIBRARY, "secondary": [], "derivedFrom": "ecg"},
}

DISABLE_OUTLIER_REMOVAL = False
# Global default library preference: "neurokit", "biosppy", or None (run both).
SELECTED_LIBRARY_PREFERENCE: Optional[str] = None
SIGNAL_KIND_LIBRARY_PREFERENCES: Dict[str, str] = {}
# Channel kind/axis overrides and exclusions sourced from the run config.
SIGNAL_KIND_OVERRIDES: Dict[str, str] = {}
SIGNAL_AXIS_OVERRIDES: Dict[str, str] = {}
EXCLUDED_CHANNELS: set = set()

ANALYSIS_WINDOW_SECONDS: Optional[Tuple[float, Optional[float]]] = None
ANALYSIS_SEGMENT: Optional[int] = None

DEFAULT_EMG_WINDOW_MS = 200.0
DEFAULT_EMG_WINDOW_STEP_MS = 100.0
EMG_WINDOW_MS: float = DEFAULT_EMG_WINDOW_MS
EMG_WINDOW_STEP_MS: float = DEFAULT_EMG_WINDOW_STEP_MS

DEFAULT_HRV_WINDOW_SEC = 300.0
DEFAULT_HRV_WINDOW_STEP_SEC = 300.0
HRV_WINDOW_SEC: float = DEFAULT_HRV_WINDOW_SEC
HRV_WINDOW_STEP_SEC: float = DEFAULT_HRV_WINDOW_STEP_SEC

def segment_artifact_folder(output_folder: Path, segment_index: int) -> Path:
    if ANALYSIS_SEGMENT is not None:
        return output_folder
    return output_folder / f"segment-{segment_index}"


def _normalize_library_pref(value: Any) -> Optional[str]:
    """Normalize a free-form library token to "neurokit", "biosppy", or Default."""
    text = str(value or "").strip().lower()
    if text in ("neurokit", "neurokit2", "nk"):
        return "neurokit"
    if text in ("biosppy", "bio"):
        return "biosppy"
    return None


def resolve_library_preference(signal_kind: Optional[str]) -> Optional[str]:
    """Resolve which single library to use for a signal kind."""
    normalized_kind = str(signal_kind or "").strip().lower()
    if normalized_kind and normalized_kind in SIGNAL_KIND_LIBRARY_PREFERENCES:
        return SIGNAL_KIND_LIBRARY_PREFERENCES[normalized_kind]
    return SELECTED_LIBRARY_PREFERENCE


def _biosppy_enabled_for(signal_kind: Optional[str]) -> bool:
    return resolve_library_preference(signal_kind) != "neurokit"


def _neurokit_enabled_for(signal_kind: Optional[str]) -> bool:
    return nk is not None and resolve_library_preference(signal_kind) != "biosppy"

def _allows_biosppy_progress() -> bool:
    return SELECTED_LIBRARY_PREFERENCE is None or SELECTED_LIBRARY_PREFERENCE != "neurokit"


def _allows_neurokit2_progress() -> bool:
    return SELECTED_LIBRARY_PREFERENCE is None or SELECTED_LIBRARY_PREFERENCE != "biosppy"

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
        "--config",
        default=os.environ.get("SENSE_ANALYSIS_CONFIG", "").strip() or None,
        help=(
            "Path to a JSON run-config file. When provided it supersedes the legacy "
            "SENSE_ANALYSIS_* env-vars and the --eda-method/--disable-outlier-removal flags."
        ),
    )
    parser.add_argument(
        "--eda-method",
        default=os.environ.get("SENSE_ANALYSIS_EDA_METHOD", "").strip() or "",
        help=(
            "Preferred analysis library for signals: 'neurokit', 'biosppy', or 'both'. "
            "When unset or empty the worker will attempt to run both libraries when available."
        ),
    )
    parser.add_argument(
        "--disable-outlier-removal",
        action="store_true",
        default=bool(str(os.environ.get("SENSE_ANALYSIS_DISABLE_OUTLIER_REMOVAL", "")).strip()),
        help="Disable library-provided outlier removal (NeuroKit2 / BioSPPy).",
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


def normalize_signal_kind_library_map(raw_map: Any) -> Dict[str, str]:
    """Normalize a {signalKind: library} map, dropping unknown kinds and the
    'auto'/None entries that mean 'use the global default'."""
    if not isinstance(raw_map, dict):
        return {}

    normalized: Dict[str, str] = {}
    for kind, library in raw_map.items():
        if not isinstance(kind, str):
            continue
        candidate_kind = kind.strip().lower()
        if candidate_kind not in SUPPORTED_SIGNAL_KINDS:
            continue
        candidate_library = _normalize_library_pref(library)
        if candidate_library is not None:
            normalized[candidate_kind] = candidate_library
    return normalized


def normalize_excluded_channels(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []

    result: List[str] = []
    for item in value:
        if isinstance(item, str):
            channel = item.strip()
            if channel and channel not in result:
                result.append(channel)
    return result


def normalize_analysis_range(value: Any) -> Optional[Tuple[float, Optional[float]]]:
    """Parse an optional analysis window {startSec, endSec} into a (start, end)
    tuple of seconds. Returns None (analyze whole session) when absent or invalid."""
    if not isinstance(value, dict):
        return None
    start = safe_float(value.get("startSec"))
    end = safe_float(value.get("endSec"))
    if start is None or start < 0:
        start = 0.0
    if end is None:
        return (float(start), None)
    if end <= start:
        return None
    return (float(start), float(end))


def normalize_analysis_segment(value: Any) -> Optional[int]:
    parsed = safe_float(value)
    if parsed is None:
        return None
    segment = int(parsed)
    return segment if segment >= 1 else None


def normalize_emg_window(window_value: Any, step_value: Any) -> Tuple[float, float]:
    """Parse the EMG sliding-window length and step (milliseconds) from the run
    config. Falls back to the defaults for missing/invalid values, defaults the
    step to 50% overlap when only the window is given, and clamps the step to the
    window length (a longer step would skip samples between windows)."""
    window_ms = safe_float(window_value)
    if window_ms is None or window_ms <= 0:
        window_ms = DEFAULT_EMG_WINDOW_MS

    step_ms = safe_float(step_value)
    if step_ms is None or step_ms <= 0:
        step_ms = window_ms / 2.0
    if step_ms > window_ms:
        step_ms = window_ms

    return float(window_ms), float(step_ms)


def normalize_hrv_window(window_value: Any, step_value: Any) -> Tuple[float, float]:
    """Parse the ECG/PPG HRV/PRV window length and step (seconds) from the run
    config. Falls back to the 5-min Task Force default, defaults the step to the
    window length (consecutive non-overlapping windows), and clamps the step to
    the window length."""
    window_sec = safe_float(window_value)
    if window_sec is None or window_sec <= 0:
        window_sec = DEFAULT_HRV_WINDOW_SEC

    step_sec = safe_float(step_value)
    if step_sec is None or step_sec <= 0:
        step_sec = window_sec
    if step_sec > window_sec:
        step_sec = window_sec

    return float(window_sec), float(step_sec)


def load_run_config(args: argparse.Namespace) -> Dict[str, Any]:
    config_path = getattr(args, "config", None)
    if config_path:
        path = Path(config_path)
        if not path.exists():
            raise FileNotFoundError(f"Analysis config file not found: {path}")
        raw = load_json(path)
        if not isinstance(raw, dict):
            raise ValueError("Analysis config file must contain a JSON object")
        emg_window_ms, emg_window_step_ms = normalize_emg_window(
            raw.get("emgWindowMs"), raw.get("emgWindowStepMs")
        )
        hrv_window_sec, hrv_window_step_sec = normalize_hrv_window(
            raw.get("hrvWindowSec"), raw.get("hrvWindowStepSec")
        )
        return {
            "libraryPreference": _normalize_library_pref(raw.get("libraryPreference")),
            "signalKindLibraries": normalize_signal_kind_library_map(raw.get("signalKindLibraries")),
            "disableOutlierRemoval": bool(raw.get("disableOutlierRemoval", False)),
            "signalKinds": normalize_signal_kind_map(raw.get("channelSignalKinds")),
            "signalAxes": normalize_signal_axis_map(raw.get("channelSignalAxes")),
            "excludedChannels": normalize_excluded_channels(raw.get("excludedChannels")),
            "range": normalize_analysis_range(raw.get("range")),
            "segment": normalize_analysis_segment(raw.get("segment")),
            "emgWindowMs": emg_window_ms,
            "emgWindowStepMs": emg_window_step_ms,
            "hrvWindowSec": hrv_window_sec,
            "hrvWindowStepSec": hrv_window_step_sec,
        }

    return {
        "libraryPreference": _normalize_library_pref(getattr(args, "eda_method", None)),
        "signalKindLibraries": {},
        "disableOutlierRemoval": bool(getattr(args, "disable_outlier_removal", False)),
        "signalKinds": load_signal_kind_overrides(),
        "signalAxes": load_signal_axis_overrides(),
        "excludedChannels": [],
        "range": None,
        "segment": None,
        "emgWindowMs": DEFAULT_EMG_WINDOW_MS,
        "emgWindowStepMs": DEFAULT_EMG_WINDOW_STEP_MS,
        "hrvWindowSec": DEFAULT_HRV_WINDOW_SEC,
        "hrvWindowStepSec": DEFAULT_HRV_WINDOW_STEP_SEC,
    }


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


def signal_library_policy(signal_kind: Optional[str]) -> Dict[str, Any]:
    normalized_kind = str(signal_kind or "").strip().lower()
    policy = dict(SIGNAL_LIBRARY_POLICY.get(normalized_kind, {"primary": None, "secondary": []}))
    policy["signalKind"] = normalized_kind or "unknown"
    if normalized_kind and normalized_kind not in SIGNAL_LIBRARY_POLICY:
        policy["primary"] = None
        policy["secondary"] = []
    return policy


def build_library_policy_manifest() -> Dict[str, Any]:
    signal_policies = {
        signal_kind: signal_library_policy(signal_kind)
        for signal_kind in sorted(SUPPORTED_SIGNAL_KINDS)
    }
    signal_policies["hrv"] = signal_library_policy("hrv")

    return {
        "summary": "BioSPPy primary + NeuroKit2 secondary on overlapping signals",
        "primaryLibrary": PRIMARY_LIBRARY,
        "secondaryLibrary": SECONDARY_LIBRARY,
        "signalPolicies": signal_policies,
    }


def detect_library_versions() -> Dict[str, Optional[str]]:
    """Best-effort capture of the installed library versions so the preprocessing
    reference in analysis.json is pinned to what actually ran."""
    versions: Dict[str, Optional[str]] = {"biosppy": None, "neurokit2": None}
    try:
        import biosppy  # local import: BioSPPy isn't imported at module load
        versions["biosppy"] = getattr(biosppy, "__version__", None)
    except Exception:
        pass
    if nk is not None:
        versions["neurokit2"] = getattr(nk, "__version__", None)
    return versions


def normalize_channel_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []

    result: List[str] = []
    for item in value:
        if isinstance(item, str):
            channel = item.strip()
            if channel and channel not in result:
                result.append(channel)
    return result


def ordered_channels(manifest: Dict[str, Any], channel_keys: Sequence[str]) -> List[str]:
    available = [str(channel) for channel in channel_keys]
    preferred_order = normalize_channel_list(manifest.get("channels"))

    ordered = [channel for channel in preferred_order if channel in available]
    for channel in available:
        if channel not in ordered:
            ordered.append(channel)
    return ordered


def ordered_eeg_channels(manifest: Dict[str, Any], available_channels: Sequence[str]) -> List[str]:
    available = [str(channel) for channel in available_channels]
    preferred_order = normalize_channel_list(manifest.get("eegChannels"))

    ordered = [channel for channel in preferred_order if channel in available]
    if ordered:
        return ordered

    return [channel for channel in available if (infer_signal_kind(manifest, channel) or "").lower() == "eeg"]


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

        channels = ordered_channels(manifest, sorted({key for frame in frames for key in frame_channels(frame).keys()}))
        acc_group_counted = False
        eeg_group_counted = False
        for channel_key in channels:
            if channel_key in EXCLUDED_CHANNELS:
                continue
            normalized_kind = (infer_signal_kind(manifest, channel_key) or "").lower()
            normalized_axis = infer_signal_axis(manifest, channel_key) if normalized_kind == "acc" else None
            if normalized_kind == "acc" and normalized_axis in ACC_AXIS_ORDER:
                if not acc_group_counted and _allows_biosppy_progress():
                    biosppy_total += 1
                    acc_group_counted = True
                continue
            if normalized_kind == "eeg":
                if not eeg_group_counted:
                    if _allows_biosppy_progress():
                        biosppy_total += 1
                    if _allows_neurokit2_progress():
                        neurokit2_total += 1
                    eeg_group_counted = True
                continue
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS and _allows_biosppy_progress():
                biosppy_total += 1
            if normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS and _allows_neurokit2_progress():
                neurokit2_total += 1

    return biosppy_total, neurokit2_total


def basic_stats(values: Sequence[float]) -> Dict[str, Any]:
    if not values:
        return {"count": 0, "mean": None, "median": None, "std": None, "min": None, "max": None}

    if len(values) == 1:
        return {
            "count": 1,
            "mean": values[0],
            "median": values[0],
            "std": 0.0,
            "min": values[0],
            "max": values[0],
        }

    return {
        "count": len(values),
        "mean": mean(values),
        "median": median(values),
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


def export_emg_windows_csv(
    output_folder: Path,
    channel_name: str,
    windows: Sequence[Dict[str, Any]],
) -> str:
    """Export the per-window EMG feature time series to a single CSV.

    One row per sliding window, with the window's time span and the Hudgins
    time-domain set + spectral indices (MAV/RMS/WL/ZC/SSC/MNF/MDF)."""
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in channel_name
    ).strip("_") or "channel"
    windows_dir = output_folder / "emg_windows"
    windows_dir.mkdir(parents=True, exist_ok=True)
    csv_path = windows_dir / f"{safe_name}.csv"

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["window", "start_sample", "end_sample", "start_seconds", "end_seconds"]
            + EMG_DERIVED_FEATURE_NAMES
        )
        for row in windows:
            writer.writerow(
                [
                    row.get("window"),
                    row.get("startSample"),
                    row.get("endSample"),
                    row.get("startSec"),
                    row.get("endSec"),
                ]
                + [row.get(name) for name in EMG_DERIVED_FEATURE_NAMES]
            )

    return str(csv_path)


def export_hrv_windows_csv(
    output_folder: Path,
    channel_name: str,
    windows: Sequence[Dict[str, Any]],
    subdir: str,
) -> str:
    """Export the per-window HRV (ECG) or PRV (PPG) metric time series to a CSV.

    One row per window, with the window's time span, peak count, and every HRV/PRV
    metric NeuroKit2 produced. The metric columns are discovered dynamically as
    the union across windows so differing per-window metric sets stay aligned."""
    safe_name = "".join(
        ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in channel_name
    ).strip("_") or "channel"
    windows_dir = output_folder / subdir
    windows_dir.mkdir(parents=True, exist_ok=True)
    csv_path = windows_dir / f"{safe_name}.csv"

    meta_keys = ("window", "startSec", "endSec", "peakCount")
    metric_keys = sorted({
        key
        for row in windows
        for key in row.keys()
        if key not in meta_keys
    })

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["window", "start_seconds", "end_seconds", "peak_count"] + metric_keys)
        for row in windows:
            writer.writerow(
                [row.get("window"), row.get("startSec"), row.get("endSec"), row.get("peakCount")]
                + [row.get(key) for key in metric_keys]
            )

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
    def __init__(self, biosppy_total: int, neurokit2_total: int, logger: Optional[AnalysisLogger] = None) -> None:
        self.biosppy_total = max(0, int(biosppy_total))
        self.neurokit2_total = max(0, int(neurokit2_total))
        self.logger = logger
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

        if not (force or label_changed or percentage_changed):
            return

        display_percentage = percentage
        if display_percentage <= self.last_percentage:
            display_percentage = min(self.last_percentage + 1, 99)

        if self.logger is not None:
            self.logger.log_progress(display_percentage, label)
        else:
            print(f"[progress] {display_percentage}% {label}", flush=True)
        self.last_percentage = display_percentage
        self.last_emitted_label = label

    def mark_data_prepared(self) -> None:
        self.data_prepared = True
        self.emit("Data preparation complete")

    def start_analysis(self, label: Optional[str] = None) -> None:
        """Emit initialization message for analysis phase."""
        has_biosppy = self.biosppy_total > 0
        has_neurokit2 = self.neurokit2_total > 0
        if not has_biosppy and not has_neurokit2:
            return

        if has_biosppy and not self.biosppy_started:
            self.biosppy_started = True
        if has_neurokit2 and not self.neurokit2_started:
            self.neurokit2_started = True
        if self.biosppy_started or self.neurokit2_started:
            self.emit(label or "Initializing analysis", force=True)

    def advance_biosppy(self, amount: float, label: str) -> None:
        if not _allows_biosppy_progress():
            return
        if self.biosppy_total <= 0 or amount <= 0:
            return
        self.biosppy_done = min(float(self.biosppy_total), self.biosppy_done + amount)
        self.emit(label)

    def advance_neurokit2(self, amount: float, label: str) -> None:
        if not _allows_neurokit2_progress():
            return
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


def _coerce_signal(values: Sequence[float]) -> Any:
    if np is None:
        return values

    try:
        return np.asarray(values, dtype=float)
    except Exception:
        return values


def apply_biosppy_analysis(record: Dict[str, Any], kind: str, values: Sequence[float], sample_rate: float) -> None:
    if resolve_library_preference(kind) == 'neurokit':
        record.setdefault("warnings", []).append(
            f"BioSPPy skipped due to library preference: neurokit ({(kind or 'signal').upper()})"
        )
        return

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


def _normalize_peak_indices(value: Any) -> List[int]:
    if value is None:
        return []
    if isinstance(value, dict):
        for candidate_key in (
            "peaks",
            "rpeaks",
            "ECG_R_Peaks",
            "PPG_Peaks",
            "SCR_Peaks",
            "EOG_Blinks",
            "EOG_Onsets",
            "Blinks",
        ):
            if candidate_key in value:
                return _normalize_peak_indices(value[candidate_key])
        return []
    if np is not None and hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            value = str(value)
    if not isinstance(value, (list, tuple)):
        return []

    normalized: List[int] = []
    seen = set()
    for item in value:
        candidate = safe_float(item)
        if candidate is None:
            continue
        peak_index = int(round(candidate))
        if peak_index < 0 or peak_index in seen:
            continue
        seen.add(peak_index)
        normalized.append(peak_index)
    return normalized


def _refresh_peak_feature_stats(features: Dict[str, Any], peak_key: str, peaks: Sequence[int]) -> None:
    peak_values = [float(value) for value in peaks]
    stats = basic_stats(peak_values)
    features[f"{peak_key}_count"] = stats["count"]
    features[f"{peak_key}_mean"] = stats["mean"]
    features[f"{peak_key}_std"] = stats["std"]
    features[f"{peak_key}_min"] = stats["min"]
    features[f"{peak_key}_max"] = stats["max"]


def _set_outlier_removal_status(target: Dict[str, Any], *, applied: bool, reason: Optional[str] = None, **details: Any) -> None:
    status: Dict[str, Any] = {"applied": applied}
    if reason:
        status["reason"] = reason
    for key, value in details.items():
        if value is not None:
            status[key] = value
    target["outlierRemoval"] = status


def _apply_biosppy_outlier_removal(record: Dict[str, Any], signal_kind: str, signal: Sequence[float], sample_rate: float) -> None:
    # Respect global disable flag
    try:
        if DISABLE_OUTLIER_REMOVAL:
            return
    except NameError:
        pass
    if (signal_kind or "").lower() != "ecg":
        return

    biosppy_block = record.get("biosppy")
    if not isinstance(biosppy_block, dict):
        return

    if (signal_kind or "").lower() != "ecg":
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason=f"BioSPPy outlier removal is only available for ECG, not {str(signal_kind).upper() or 'this signal'}.",
        )
        return

    output = biosppy_block.get("output")
    if not isinstance(output, dict):
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason="BioSPPy ECG outlier removal was not run because the ECG output is unavailable.",
        )
        return

    peaks = _normalize_peak_indices(output.get("rpeaks"))
    if len(peaks) < 3:
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason="BioSPPy ECG outlier removal was not run because fewer than 3 peaks were detected.",
            inputPeakCount=len(peaks),
        )
        return

    try:
        from biosppy.signals import ecg as biosppy_ecg
    except Exception:
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason="BioSPPy ECG outlier removal was not run because the BioSPPy ECG helper is unavailable.",
            inputPeakCount=len(peaks),
        )
        return

    try:
        corrected = biosppy_ecg.correct_rpeaks(
            signal=signal,
            rpeaks=peaks,
            sampling_rate=float(sample_rate),
        )
    except Exception as exc:
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason=f"BioSPPy ECG outlier removal failed: {exc}",
            inputPeakCount=len(peaks),
        )
        return

    corrected_peaks = _normalize_peak_indices(getattr(corrected, "rpeaks", None))
    if not corrected_peaks:
        _set_outlier_removal_status(
            biosppy_block,
            applied=False,
            reason="BioSPPy ECG outlier removal did not produce corrected peaks.",
            inputPeakCount=len(peaks),
        )
        return

    output["rpeaks"] = corrected_peaks
    biosppy_features = record.get("biosppyFeatures")
    if isinstance(biosppy_features, dict):
        _refresh_peak_feature_stats(biosppy_features, "rpeaks", corrected_peaks)

    biosppy_block["outlierRemoval"] = {
        "applied": True,
        "method": "biosppy.signals.ecg.correct_rpeaks",
        "inputPeakCount": len(peaks),
        "outputPeakCount": len(corrected_peaks),
        "correctedPeaks": corrected_peaks,
    }


def _apply_neurokit2_outlier_removal(record: Dict[str, Any], signal_kind: str, sample_rate: float) -> None:
    # Respect global disable flag
    try:
        if DISABLE_OUTLIER_REMOVAL:
            return
    except NameError:
        pass

    if nk is None:
        return

    nk_block = record.get("neurokit2")
    if not isinstance(nk_block, dict):
        return

    info = nk_block.get("info")
    if not isinstance(info, dict):
        _set_outlier_removal_status(
            nk_block,
            applied=False,
            reason="NeuroKit2 outlier removal was not run because peak metadata is unavailable.",
        )
        return

    peak_key_map = {
        "ecg": ["ECG_R_Peaks"],
        "ppg": ["PPG_Peaks"],
        "eda": ["SCR_Peaks", "SCR_Onsets"],
        "rsp": ["RSP_Peaks"],
        "eog": ["EOG_Blinks", "EOG_Onsets", "Blinks"],
    }

    candidate_keys = peak_key_map.get((signal_kind or "").lower(), [])
    peak_key = next((key for key in candidate_keys if key in info), None)
    if not peak_key:
        _set_outlier_removal_status(
            nk_block,
            applied=False,
            reason=f"NeuroKit2 outlier removal is not available for {str(signal_kind).upper() or 'this signal'} in the current result.",
        )
        return

    peaks = _normalize_peak_indices(info.get(peak_key))
    if len(peaks) < 3:
        _set_outlier_removal_status(
            nk_block,
            applied=False,
            reason=f"NeuroKit2 outlier removal was not run for {str(signal_kind).upper()} because fewer than 3 peaks were detected.",
            peakKey=peak_key,
            inputPeakCount=len(peaks),
        )
        return

    try:
        peaks_array = np.asarray(peaks, dtype=int) if np is not None else peaks
        correction_info, corrected_peaks = nk.signal_fixpeaks(
            peaks_array,
            sampling_rate=float(sample_rate),
            show=False,
        )
    except Exception as exc:
        _set_outlier_removal_status(
            nk_block,
            applied=False,
            reason=f"NeuroKit2 outlier removal failed: {exc}",
            peakKey=peak_key,
            inputPeakCount=len(peaks),
        )
        return

    corrected = _normalize_peak_indices(corrected_peaks)
    if not corrected:
        _set_outlier_removal_status(
            nk_block,
            applied=False,
            reason=f"NeuroKit2 outlier removal did not produce corrected peaks for {peak_key}.",
            peakKey=peak_key,
            inputPeakCount=len(peaks),
        )
        return

    info[peak_key] = corrected
    nk_block["outlierRemoval"] = {
        "applied": True,
        "method": "neurokit2.signal_fixpeaks",
        "peakKey": peak_key,
        "inputPeakCount": len(peaks),
        "outputPeakCount": len(corrected),
        "correctedPeaks": corrected,
        "correction": serialize_numpy_like(correction_info),
    }


def _finite_only_signal(signal: Any) -> Any:
    if np is not None:
        try:
            array = np.asarray(signal, dtype=float)
            if array.ndim == 0:
                return array.reshape(1)
            if array.ndim == 1:
                finite_mask = np.isfinite(array)
                return array[finite_mask] if not bool(finite_mask.all()) else array
            finite_mask = np.all(np.isfinite(array), axis=tuple(range(1, array.ndim)))
            return array[finite_mask] if not bool(finite_mask.all()) else array
        except Exception:
            pass

    if isinstance(signal, list):
        cleaned: List[Any] = []
        for item in signal:
            if isinstance(item, (list, tuple)):
                row = [_value for _value in item if safe_float(_value) is not None]
                if len(row) == len(item) and row:
                    cleaned.append(list(row))
            else:
                value = safe_float(item)
                if value is not None:
                    cleaned.append(value)
        return cleaned

    return signal


def _prepare_signal_for_analysis(signal_kind: str, values: Sequence[float], sample_rate: float) -> Tuple[Any, Dict[str, Any]]:
    normalized_kind = (signal_kind or "").lower()
    cleaned_signal = _finite_only_signal(values)
    preprocessing: Dict[str, Any] = {
        "signalKind": normalized_kind,
        "steps": ["finite-value-sanitization"],
    }

    if nk is None:
        return cleaned_signal, preprocessing

    cleaner_specs = {
        "ecg": (nk.ecg_clean, {}),
        "ppg": (nk.ppg_clean, {}),
        "emg": (nk.emg_clean, {}),
        "rsp": (nk.rsp_clean, {}),
        "eda": (nk.eda_clean, {}),
        "eog": (nk.eog_clean, {}),
    }

    cleaner_entry = cleaner_specs.get(normalized_kind)
    if cleaner_entry is None:
        return cleaned_signal, preprocessing

    cleaner, cleaner_kwargs = cleaner_entry
    try:
        cleaned_signal = cleaner(cleaned_signal, sampling_rate=float(sample_rate), **cleaner_kwargs)
        preprocessing["steps"].append(f"neurokit2.{normalized_kind}_clean")
    except Exception as exc:
        preprocessing.setdefault("warnings", []).append(f"NeuroKit2 {normalized_kind.upper()} cleaning failed: {exc}")

    return cleaned_signal, preprocessing


def compute_hrv_windowed(
    peaks: Sequence[int],
    sample_rate: float,
    signal_length: int,
    window_sec: float,
    step_sec: float,
    prv: bool = False,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any], List[str]]:
    """Run NeuroKit2's nk.hrv() over consecutive (optionally overlapping) windows
    of detected peaks, following the 5-min short-term standard.

    Used for both ECG HRV and PPG PRV (same NeuroKit engine; when prv=True the
    HRV_* metric names are relabelled PRV_* since they describe pulse-rate, not
    heart-rate, variability).

    Returns (aggregate, windows, meta, warnings):
      - aggregate: {<METRIC>_mean/_std/_min/_max + <prefix>_window_count} across
        windows, for the flat features.csv table (under the neurokit2 library).
      - windows: per-window list of dicts (window index, time span, peak count and
        every HRV/PRV metric) for the per-window time-series CSV export.
      - meta: the window parameters actually used (kept in analysis.json).
      - warnings: any issues encountered.
    """
    label = "PRV" if prv else "HRV"
    warnings: List[str] = []

    if nk is None:
        warnings.append(f"{label} windowing skipped: NeuroKit2 is unavailable.")
        return {}, [], {}, warnings
    if np is None:
        warnings.append(f"{label} windowing skipped: NumPy is unavailable.")
        return {}, [], {}, warnings
    if not sample_rate or sample_rate <= 0:
        warnings.append(f"{label} windowing skipped: sample rate unavailable.")
        return {}, [], {}, warnings

    ordered_peaks = sorted({int(p) for p in peaks if p is not None and int(p) >= 0})
    if len(ordered_peaks) < 4:
        warnings.append(f"{label} windowing skipped: fewer than 4 peaks detected.")
        return {}, [], {}, warnings

    length = int(signal_length) if signal_length else (ordered_peaks[-1] + 1)
    window_samples = max(1, int(round(window_sec * sample_rate)))
    step_samples = max(1, int(round(step_sec * sample_rate)))

    bounds: List[Tuple[int, int]] = []
    if length <= window_samples:
        bounds.append((0, length))
    else:
        start = 0
        while start + window_samples <= length:
            bounds.append((start, start + window_samples))
            start += step_samples

    meta: Dict[str, Any] = {
        "windowSec": float(window_sec),
        "stepSec": float(step_sec),
        "windowSamples": int(window_samples),
        "stepSamples": int(step_samples),
        "overlapPercent": round((1.0 - step_samples / window_samples) * 100.0, 2) if window_samples else 0.0,
        "sampleRate": float(sample_rate),
        "standard": "Task Force ESC/NASPE 1996 (5-min short-term)",
        "windowCount": 0,
    }

    windows: List[Dict[str, Any]] = []
    collected: Dict[str, List[float]] = defaultdict(list)

    for w_index, (start, end) in enumerate(bounds):
        window_peaks = [p for p in ordered_peaks if start <= p < end]
        if len(window_peaks) < 4:
            continue
        try:
            hrv_df = nk.hrv(np.asarray(window_peaks, dtype=int), sampling_rate=float(sample_rate), show=False)
        except Exception as exc:
            warnings.append(f"{label} window {w_index} failed: {exc}")
            continue

        rows = serialize_df_like(hrv_df)
        metrics = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        if prv:
            metrics = {
                (f"PRV_{key[4:]}" if isinstance(key, str) and key.startswith("HRV_") else key): value
                for key, value in metrics.items()
            }

        row: Dict[str, Any] = {
            "window": w_index,
            "startSec": start / sample_rate,
            "endSec": end / sample_rate,
            "peakCount": len(window_peaks),
        }
        for key, value in metrics.items():
            number = safe_float(value)  
            row[key] = number
            if number is not None:
                collected[str(key)].append(number)
        windows.append(row)

    meta["windowCount"] = len(windows)

    if not windows:
        warnings.append(f"{label} windowing produced no usable windows.")
        return {}, [], meta, warnings

    aggregate: Dict[str, Any] = {f"{label}_window_count": len(windows)}
    for key, series in collected.items():
        if not series:
            continue
        stats = basic_stats(series)
        aggregate[f"{key}_mean"] = stats["mean"]
        aggregate[f"{key}_std"] = stats["std"]
        aggregate[f"{key}_min"] = stats["min"]
        aggregate[f"{key}_max"] = stats["max"]

    return aggregate, windows, meta, warnings


def analyze_ecg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "ecg", "libraries": []}
    signal, preprocessing = _prepare_signal_for_analysis("ecg", values, sample_rate)
    record["preprocessing"] = preprocessing

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ECG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "ecg", signal, sample_rate)
    # Apply BioSPPy ECG peak correction (outlier removal) so downstream features use corrected peaks
    try:
        _apply_biosppy_outlier_removal(record, "ecg", signal, sample_rate)
    except Exception:
        # Don't let outlier removal failures stop analysis; record warnings are emitted inside helper
        pass
    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy ECG", channel_key, "detecting peaks & features"))

    if _neurokit_enabled_for("ecg"):
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 ECG", channel_key, "processing & HRV"))

            signals, info = nk.ecg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            _apply_neurokit2_outlier_removal(record, "ecg", sample_rate)
            if info is not None:
                try:
                    corrected_info = record["neurokit2"].get("info")
                    # Compute HRV over consecutive 5-min windows rather than once 
                    # over the whole recording. Per-window metrics go to a CSV; 
                    # cross-window aggregates flow to features.csv.
                    peaks_for_hrv = _normalize_peak_indices(corrected_info)
                    if len(peaks_for_hrv) >= 4:
                        aggregate, hrv_windows, hrv_meta, hrv_warnings = compute_hrv_windowed(
                            peaks_for_hrv,
                            float(sample_rate),
                            len(signal),
                            HRV_WINDOW_SEC,
                            HRV_WINDOW_STEP_SEC,
                            prv=False,
                        )
                        record["neurokit2"]["hrvWindowing"] = hrv_meta
                        if aggregate:
                            record["neurokit2"]["derivedFeatures"] = aggregate
                        if hrv_windows:
                            record["_hrvWindows"] = hrv_windows
                        for warning in hrv_warnings:
                            record.setdefault("warnings", []).append(warning)
                    else:
                        record.setdefault("warnings", []).append(
                            "NeuroKit2 HRV skipped: insufficient peaks after outlier removal"
                        )
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
    signal, preprocessing = _prepare_signal_for_analysis("eda", values, sample_rate)
    record["preprocessing"] = preprocessing

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EDA", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "eda", signal, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy EDA", channel_key, "detecting peaks & features"))

    if _neurokit_enabled_for("eda"):
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EDA", channel_key, "processing & decomposition"))

            try:
                signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))
            except (TypeError, ValueError):
                signals, info = nk.eda_process(signal, sampling_rate=float(sample_rate))

            record["libraries"].append("neurokit2")
            nk_block: Dict[str, Any] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            record["neurokit2"] = nk_block
            _apply_neurokit2_outlier_removal(record, "eda", sample_rate)
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
    signal, preprocessing = _prepare_signal_for_analysis("ppg", values, sample_rate)
    record["preprocessing"] = preprocessing

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PPG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "ppg", signal, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy PPG", channel_key, "detecting peaks & features"))

    if _neurokit_enabled_for("ppg"):
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 PPG", channel_key, "processing & features"))

            signals, info = nk.ppg_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            _apply_neurokit2_outlier_removal(record, "ppg", sample_rate)

            # Pulse-rate variability: feed the detected PPG pulse peaks to the
            # same NeuroKit2 HRV engine over 5-min windows.
            try:
                corrected_info = record["neurokit2"].get("info")
                peaks_for_prv = _normalize_peak_indices(corrected_info)
                if len(peaks_for_prv) >= 4:
                    aggregate, prv_windows, prv_meta, prv_warnings = compute_hrv_windowed(
                        peaks_for_prv,
                        float(sample_rate),
                        len(signal),
                        HRV_WINDOW_SEC,
                        HRV_WINDOW_STEP_SEC,
                        prv=True,
                    )
                    record["neurokit2"]["prvWindowing"] = prv_meta
                    if aggregate:
                        record["neurokit2"]["derivedFeatures"] = aggregate
                    if prv_windows:
                        record["_hrvWindows"] = prv_windows
                    for warning in prv_warnings:
                        record.setdefault("warnings", []).append(warning)
                else:
                    record.setdefault("warnings", []).append(
                        "NeuroKit2 PRV skipped: insufficient pulse peaks detected"
                    )
            except Exception as exc:
                record.setdefault("warnings", []).append(f"NeuroKit2 PRV processing failed: {exc}")
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 PPG processing failed: {exc}")

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PPG", channel_key, "complete"))
        progress.advance_neurokit2(0.8, _progress_label("NeuroKit2 PPG", channel_key, "complete"))

    return record


def compute_emg_time_frequency_features(
    signal: Any,
    sample_rate: float,
) -> Tuple[Dict[str, Any], List[str]]:
    """Compute the Hudgins time-domain set (MAV, RMS, WL, ZC, SSC) plus the
    spectral fatigue indices (MNF, MDF) on a cleaned EMG signal.
    """
    features: Dict[str, Any] = {}
    warnings: List[str] = []

    if np is None:
        warnings.append("EMG time/frequency features skipped: NumPy is unavailable.")
        return features, warnings

    try:
        x = np.asarray(signal, dtype=float).reshape(-1)
        x = x[np.isfinite(x)]
    except Exception as exc:
        warnings.append(f"EMG time/frequency features skipped: {exc}")
        return features, warnings

    if x.size < 2:
        warnings.append("EMG time/frequency features skipped: fewer than 2 samples.")
        return features, warnings

    # --- Time-domain set ---
    diff = np.diff(x)
    features["EMG_MAV"] = float(np.mean(np.abs(x)))         
    features["EMG_RMS"] = float(np.sqrt(np.mean(x ** 2)))   
    features["EMG_WL"] = float(np.sum(np.abs(diff)))        

    signs = np.sign(x)
    signs[signs == 0] = 1.0
    features["EMG_ZC"] = int(np.sum(signs[:-1] * signs[1:] < 0))

    if diff.size >= 2:
        dsigns = np.sign(diff)
        dsigns[dsigns == 0] = 1.0
        features["EMG_SSC"] = int(np.sum(dsigns[:-1] * dsigns[1:] < 0))
    else:
        features["EMG_SSC"] = 0

    if sample_rate and sample_rate > 0:
        try:
            from scipy.signal import welch

            nperseg = int(min(x.size, max(256, int(sample_rate))))
            freqs, psd = welch(x, fs=float(sample_rate), nperseg=nperseg)
            total_power = float(np.sum(psd))
            if total_power > 0 and freqs.size:
                features["EMG_MNF"] = float(np.sum(freqs * psd) / total_power)
                cumulative = np.cumsum(psd)
                median_idx = min(int(np.searchsorted(cumulative, total_power / 2.0)), freqs.size - 1)
                features["EMG_MDF"] = float(freqs[median_idx])
            else:
                warnings.append("EMG spectral features (MNF/MDF) skipped: PSD has no power.")
        except Exception as exc:
            warnings.append(f"EMG spectral features (MNF/MDF) skipped: {exc}")
    else:
        warnings.append("EMG spectral features (MNF/MDF) skipped: sample rate unavailable.")

    return features, warnings


EMG_DERIVED_FEATURE_NAMES = ["EMG_MAV", "EMG_RMS", "EMG_WL", "EMG_ZC", "EMG_SSC", "EMG_MNF", "EMG_MDF"]


def compute_emg_windowed_features(
    signal: Any,
    sample_rate: float,
    window_ms: float,
    step_ms: float,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], Dict[str, Any], List[str]]:
    """Slide an overlapping window over the cleaned EMG signal and compute the
    Hudgins time-domain set + spectral indices per window.

    Returns (aggregate, windows, windowing_meta, warnings):
      - aggregate: {<FEATURE>_mean/_std/_min/_max + EMG_window_count} across all
        windows, for the flat features.csv table.
      - windows: per-window list of dicts (window index, start/end sample & sec,
        and each feature) for the per-window time-series CSV export.
      - windowing_meta: the window parameters actually used (kept in analysis.json).
      - warnings: any issues encountered.
    """
    warnings: List[str] = []

    if np is None:
        warnings.append("EMG windowed features skipped: NumPy is unavailable.")
        return {}, [], {}, warnings

    if not sample_rate or sample_rate <= 0:
        warnings.append("EMG windowed features skipped: sample rate unavailable.")
        return {}, [], {}, warnings

    try:
        x = np.asarray(signal, dtype=float).reshape(-1)
        x = x[np.isfinite(x)]
    except Exception as exc:
        warnings.append(f"EMG windowed features skipped: {exc}")
        return {}, [], {}, warnings

    window_samples = max(2, int(round(window_ms * sample_rate / 1000.0)))
    step_samples = max(1, int(round(step_ms * sample_rate / 1000.0)))

    windowing_meta: Dict[str, Any] = {
        "windowMs": float(window_ms),
        "stepMs": float(step_ms),
        "windowSamples": int(window_samples),
        "stepSamples": int(step_samples),
        "overlapPercent": round((1.0 - step_samples / window_samples) * 100.0, 2) if window_samples else 0.0,
        "sampleRate": float(sample_rate),
        "windowCount": 0,
    }

    if x.size < window_samples:
        warnings.append(
            f"EMG windowed features skipped: signal has {int(x.size)} samples, "
            f"fewer than one {window_ms:g}ms window ({window_samples} samples)."
        )
        return {}, [], windowing_meta, warnings

    windows: List[Dict[str, Any]] = []
    collected: Dict[str, List[float]] = {name: [] for name in EMG_DERIVED_FEATURE_NAMES}

    for w_index, start in enumerate(range(0, x.size - window_samples + 1, step_samples)):
        end = start + window_samples
        seg_features, _seg_warnings = compute_emg_time_frequency_features(x[start:end], sample_rate)
        if not seg_features:
            continue
        row: Dict[str, Any] = {
            "window": w_index,
            "startSample": int(start),
            "endSample": int(end),
            "startSec": start / sample_rate,
            "endSec": end / sample_rate,
        }
        for name in EMG_DERIVED_FEATURE_NAMES:
            value = seg_features.get(name)
            row[name] = value
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                collected[name].append(float(value))
        windows.append(row)

    windowing_meta["windowCount"] = len(windows)

    if not windows:
        warnings.append("EMG windowed features produced no usable windows.")
        return {}, [], windowing_meta, warnings

    aggregate: Dict[str, Any] = {"EMG_window_count": len(windows)}
    for name in EMG_DERIVED_FEATURE_NAMES:
        series = collected[name]
        if not series:
            continue
        stats = basic_stats(series)
        aggregate[f"{name}_mean"] = stats["mean"]
        aggregate[f"{name}_std"] = stats["std"]
        aggregate[f"{name}_min"] = stats["min"]
        aggregate[f"{name}_max"] = stats["max"]

    return aggregate, windows, windowing_meta, warnings


def analyze_emg(
    values: Sequence[float],
    sample_rate: float,
    channel_key: Optional[str] = None,
    progress: Optional[AnalysisProgressTracker] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {"signalKind": "emg", "libraries": []}
    signal, preprocessing = _prepare_signal_for_analysis("emg", values, sample_rate)
    record["preprocessing"] = preprocessing

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EMG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "emg", signal, sample_rate)

    aggregate, emg_windows, windowing_meta, emg_warnings = compute_emg_windowed_features(
        signal, sample_rate, EMG_WINDOW_MS, EMG_WINDOW_STEP_MS
    )
    if windowing_meta:
        record["windowing"] = windowing_meta
    if aggregate:
        record["derivedFeatures"] = aggregate
    if emg_windows:
        record["_emgWindows"] = emg_windows
    for warning in emg_warnings:
        record.setdefault("warnings", []).append(warning)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy EMG", channel_key, "detecting peaks & features"))

    if _neurokit_enabled_for("emg"):
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
    signal, preprocessing = _prepare_signal_for_analysis("rsp", values, sample_rate)
    record["preprocessing"] = preprocessing

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy RSP", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "rsp", signal, sample_rate)

    if progress is not None:
        progress.advance_biosppy(0.5, _progress_label("BioSPPy RSP", channel_key, "detecting peaks & features"))

    if _neurokit_enabled_for("rsp"):
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 RSP", channel_key, "processing & features"))

            signals, info = nk.rsp_process(signal, sampling_rate=float(sample_rate))
            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "signalsColumns": list(getattr(signals, "columns", [])),
                "info": serialize_numpy_like(info),
            }
            _apply_neurokit2_outlier_removal(record, "rsp", sample_rate)
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
    signal, preprocessing = _prepare_signal_for_analysis("eog", values, sample_rate)
    record["preprocessing"] = preprocessing

    if _neurokit_enabled_for("eog"):
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
            _apply_neurokit2_outlier_removal(record, "eog", sample_rate)
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
    signal, preprocessing = _prepare_signal_for_analysis("eeg", values, sample_rate)
    record["preprocessing"] = preprocessing
    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy EEG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "eeg", signal, sample_rate)

    if _neurokit_enabled_for("eeg"):
        try:
            if progress is not None:
                progress.advance_neurokit2(0.2, _progress_label("NeuroKit2 EEG", channel_key, "processing & features"))

            import mne

            matrix = np.asarray(signal, dtype=float)
            if matrix.ndim == 1:
                matrix = matrix.reshape(-1, 1)
            channel_count = int(matrix.shape[1])
            mne_info = mne.create_info(
                [f"EEG{index + 1}" for index in range(channel_count)],
                sfreq=float(sample_rate),
                ch_types="eeg",
            )
            raw = mne.io.RawArray(matrix.T, mne_info, verbose="ERROR")

            power = nk.eeg_power(
                raw,
                sampling_rate=float(sample_rate),
                frequency_band=["Delta", "Theta", "Alpha", "Beta", "Gamma"],
            )
            band_columns = [column for column in getattr(power, "columns", []) if column != "Channel"]
            band_info: Dict[str, Any] = {}
            for band in band_columns:
                values = [safe_float(value) for value in power[band].tolist()]
                values = [value for value in values if value is not None]
                if values:
                    band_info[f"EEG_Power_{band}"] = values

            record["libraries"].append("neurokit2")
            record["neurokit2"] = {
                "method": "neurokit2.eeg_power",
                "bands": band_columns,
                "channelCount": channel_count,
                "info": band_info,
            }
        except Exception as exc:
            record.setdefault("warnings", []).append(f"NeuroKit2 EEG band-power extraction failed: {exc}")

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
    signal, preprocessing = _prepare_signal_for_analysis("pcg", values, sample_rate)
    record["preprocessing"] = preprocessing
    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy PCG", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "pcg", signal, sample_rate)

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
    signal, preprocessing = _prepare_signal_for_analysis("acc", values, sample_rate)
    record["preprocessing"] = preprocessing

    axis_count = 1
    if np is not None and hasattr(signal, "ndim"):
        if signal.ndim > 1:
            axis_count = int(signal.shape[1])
    elif values and isinstance(values[0], (list, tuple)):
        axis_count = len(values[0])

    if axis_count <= 1:
        record["analysis"] = analyze_generic(values)
        record.setdefault("warnings", []).append(
            "BioSPPy ACC vector features require at least two axes; using scalar ACC fallback."
        )
        return record

    if progress is not None:
        progress.advance_biosppy(0.25, _progress_label("BioSPPy ACC", channel_key, "filtering & segmentation"))

    apply_biosppy_analysis(record, "acc", signal, sample_rate)
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
    record["libraryPolicy"] = signal_library_policy(normalized_kind)

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
        if isinstance(analysis_record, dict):
            # Apply any library-provided outlier removal available for the override
            try:
                _apply_biosppy_outlier_removal(analysis_record, normalized_kind, values, sample_rate)
            except Exception:
                pass
            try:
                _apply_neurokit2_outlier_removal(analysis_record, normalized_kind, sample_rate)
            except Exception:
                pass
            extract_neurokit2_features(analysis_record)

            preprocessing = analysis_record.get("preprocessing")
            if isinstance(preprocessing, dict):
                record["preprocessing"] = preprocessing

            outlier_info: Dict[str, Any] = {}
            biosppy_block = analysis_record.get("biosppy") if isinstance(analysis_record.get("biosppy"), dict) else None
            nk_block = analysis_record.get("neurokit2") if isinstance(analysis_record.get("neurokit2"), dict) else None
            if biosppy_block and isinstance(biosppy_block.get("outlierRemoval"), dict):
                outlier_info["biosppy"] = biosppy_block.get("outlierRemoval")
            if nk_block and isinstance(nk_block.get("outlierRemoval"), dict):
                outlier_info["neurokit2"] = nk_block.get("outlierRemoval")
            if outlier_info:
                record["outlierRemoval"] = outlier_info
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

        # Promote preprocessing metadata to the channel-level record for visibility
        preprocessing = analysis_record.get("preprocessing")
        if isinstance(preprocessing, dict):
            record["preprocessing"] = preprocessing

        # Collect outlier removal info from library blocks (if any) and expose at top-level
        outlier_info: Dict[str, Any] = {}
        biosppy_block = analysis_record.get("biosppy") if isinstance(analysis_record.get("biosppy"), dict) else None
        nk_block = analysis_record.get("neurokit2") if isinstance(analysis_record.get("neurokit2"), dict) else None
        if biosppy_block and isinstance(biosppy_block.get("outlierRemoval"), dict):
            outlier_info["biosppy"] = biosppy_block.get("outlierRemoval")
        if nk_block and isinstance(nk_block.get("outlierRemoval"), dict):
            outlier_info["neurokit2"] = nk_block.get("outlierRemoval")
        if outlier_info:
            record["outlierRemoval"] = outlier_info
        elif not DISABLE_OUTLIER_REMOVAL:
            if normalized_kind in {"ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg", "pcg", "acc"}:
                if normalized_kind == "acc":
                    reason = "Outlier removal is not available for ACC channels."
                elif normalized_kind == "pcg":
                    reason = "Outlier removal is not available for PCG channels."
                elif normalized_kind == "eeg":
                    reason = "Outlier removal is not available for EEG channels in this worker."
                elif normalized_kind == "ecg":
                    reason = "Outlier removal was enabled, but no library produced corrected peaks for this ECG channel."
                else:
                    reason = f"Outlier removal was enabled, but no correction step ran for {normalized_kind.upper()}."
                record["outlierRemoval"] = {
                    "applied": False,
                    "reason": reason,
                }

    return record


def process_segment(
    segment_index: int,
    manifest: Dict[str, Any],
    sample_rate: float,
    chunk_files: Sequence[Path],
    output_folder: Path,
    eda_method: Optional[str],
    progress: Optional[AnalysisProgressTracker] = None,
    logger: Optional[AnalysisLogger] = None,
    session_frame_offset: int = 0,
    window_frames: Optional[Tuple[int, Optional[int]]] = None,
) -> Dict[str, Any]:
    if logger is not None:
        logger.log_message(
            f"[analysis][segment-{segment_index}] loading {len(chunk_files)} chunk file(s)",
            step="segment_load",
            segment=segment_index,
            chunkCount=len(chunk_files),
        )

    frames: List[Dict[str, Any]] = []
    for chunk_file in chunk_files:
        frames.extend(load_chunk_frames(chunk_file))

    # Total # frames (before window restriction)
    raw_frame_count = len(frames)
    
    if window_frames is not None:
        abs_start, abs_end = window_frames
        local_start = max(0, abs_start - session_frame_offset)
        local_end = raw_frame_count if abs_end is None else min(raw_frame_count, abs_end - session_frame_offset)
        frames = frames[local_start:local_end] if local_start < local_end else []

    frame_count = len(frames)

    if frame_count == 0:
        return {
            "segment": segment_index,
            "chunkFiles": [str(path) for path in chunk_files],
            "frameCount": 0,
            "rawFrameCount": raw_frame_count,
            "channels": [],
            "warnings": ["Segment contains no frames to process"],
        }

    if logger is not None:
        logger.log_message(
            f"[analysis][segment-{segment_index}] processing {frame_count} frame(s)",
            step="segment_process",
            segment=segment_index,
            frameCount=frame_count,
        )

    channels = ordered_channels(manifest, sorted({key for frame in frames for key in frame_channels(frame).keys()}))
    result_channels: List[Dict[str, Any]] = []
    acc_group_entries: List[Dict[str, Any]] = []
    eeg_group_entries: List[Dict[str, Any]] = []
    for channel_key in channels:
        label = infer_label(channel_key, manifest)
        kind = infer_signal_kind(manifest, channel_key)
        axis = infer_signal_axis(manifest, channel_key) if (kind or "").lower() == "acc" else None
        
        if progress is not None:
            normalized_kind = (kind or "").lower()
            if normalized_kind in BIOSPPY_PROGRESS_SIGNAL_KINDS and normalized_kind in NEUROKIT2_PROGRESS_SIGNAL_KINDS:
                progress.start_analysis(
                    label=_progress_label(normalized_kind.upper(), channel_key, "initializing analysis"),
                )
        
        indices, values = channel_series(frames, channel_key)

        if channel_key in EXCLUDED_CHANNELS:
            excluded_result = analyze_channel(
                channel_key=channel_key,
                label=label,
                kind=None,
                values=values,
                sample_rate=sample_rate,
                indices=indices,
                output_folder=segment_artifact_folder(output_folder, segment_index),
                eda_method=eda_method,
                progress=None,
            )
            channel_record = dict(excluded_result)
            channel_record["channel"] = channel_key
            channel_record["label"] = label
            channel_record["signalKind"] = kind or "generic"
            channel_record["excluded"] = True
            if axis in ACC_AXIS_ORDER:
                channel_record["accAxis"] = axis
            channel_record.setdefault("warnings", []).append(
                "Channel excluded from library analysis; exported raw series and basic statistics only."
            )
            result_channels.append(channel_record)
            continue

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

        if (kind or "").lower() == "eeg":
            if not values:
                result_channels.append({
                    "channel": channel_key,
                    "label": label,
                    "signalKind": kind or "generic",
                    "summary": {"count": 0, "mean": None, "std": None, "min": None, "max": None},
                    "warnings": ["Channel contains no valid samples"],
                })
                if progress is not None:
                    progress.advance_biosppy(1, f"BioSPPy: EEG ({label})")
                    progress.advance_neurokit2(1, f"NeuroKit2: EEG ({label})")
                continue

            eeg_group_entries.append({
                "channel": channel_key,
                "label": label,
                "kind": kind,
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
            output_folder=segment_artifact_folder(output_folder, segment_index),
            eda_method=eda_method,
            progress=progress,
        )
        channel_record = dict(channel_result)
        channel_record["channel"] = channel_key
        channel_record["label"] = label
        channel_record["signalKind"] = kind or "generic"

        result_channels.append(channel_record)

    if eeg_group_entries:
        ordered_eeg_entries = ordered_eeg_channels(
            manifest,
            [str(entry["channel"]) for entry in eeg_group_entries],
        )
        eeg_entries_by_channel = {str(entry["channel"]): entry for entry in eeg_group_entries}
        eeg_group_channels = [channel for channel in ordered_eeg_entries if channel in eeg_entries_by_channel]
        eeg_group_label = ", ".join(
            str(eeg_entries_by_channel[channel]["label"])
            for channel in eeg_group_channels
            if eeg_entries_by_channel[channel].get("label")
        ) or "EEG"
        group_indices, group_values = channel_matrix_series(frames, eeg_group_channels)

        if group_values:
            eeg_analysis = analyze_eeg(group_values, sample_rate, channel_key=eeg_group_label, progress=progress)
        else:
            eeg_analysis = {
                "signalKind": "eeg",
                "libraries": [],
                "analysis": analyze_generic([]),
                "warnings": ["EEG channels could not be aligned into a shared multi-channel signal; using scalar fallbacks."],
            }

        for entry in eeg_group_channels:
            eeg_entry = eeg_entries_by_channel[entry]
            channel_result = analyze_channel(
                channel_key=str(eeg_entry["channel"]),
                label=str(eeg_entry["label"]),
                kind=str(eeg_entry["kind"]),
                values=eeg_entry["values"],
                sample_rate=sample_rate,
                indices=eeg_entry["indices"],
                output_folder=segment_artifact_folder(output_folder, segment_index),
                eda_method=eda_method,
                progress=None,
                analysis_override=eeg_analysis,
            )
            channel_record = dict(channel_result)
            channel_record["channel"] = str(eeg_entry["channel"])
            channel_record["label"] = str(eeg_entry["label"])
            channel_record["signalKind"] = "eeg"
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
                output_folder=segment_artifact_folder(output_folder, segment_index),
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
        "rawFrameCount": raw_frame_count,
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


def build_result(
    session_folder: Path,
    output_folder: Path,
    eda_method: Optional[str],
    logger: Optional[AnalysisLogger] = None,
) -> Tuple[Dict[str, Any], AnalysisProgressTracker]:
    if logger is not None:
        logger.log_progress(1, "Loading chunks and parsing data")
    else:
        print("[progress] 1% Loading chunks and parsing data", flush=True)
    manifest = load_session_manifest(session_folder)
    sample_rate = resolve_sample_rate(manifest)
    chunk_entries = discover_chunk_entries(session_folder, manifest)
    if not chunk_entries:
        raise FileNotFoundError(f"No chunk files found in {session_folder}")

    selected_signal_kinds = dict(SIGNAL_KIND_OVERRIDES)
    selected_signal_axes = dict(SIGNAL_AXIS_OVERRIDES)
    analysis_manifest = dict(manifest)
    analysis_manifest["channelSignalKinds"] = merge_signal_kind_maps(manifest, selected_signal_kinds)
    analysis_manifest["channelSignalAxes"] = merge_signal_axis_maps(manifest, selected_signal_axes)
    analysis_manifest["eegChannels"] = normalize_channel_list(manifest.get("eegChannels"))
    library_policy = build_library_policy_manifest()

    grouped_entries = group_entries_by_segment(chunk_entries)
    
    if ANALYSIS_SEGMENT is not None:
        grouped_entries = {
            ANALYSIS_SEGMENT: grouped_entries.get(ANALYSIS_SEGMENT, [])
        }
    segment_results: List[Dict[str, Any]] = []
    total_frames = 0
    total_chunks = 0

    biosppy_total, neurokit2_total = count_progress_units(grouped_entries, analysis_manifest)
    progress = AnalysisProgressTracker(biosppy_total, neurokit2_total, logger=logger)
    progress.mark_data_prepared()

    signal_kind_counts: Dict[str, int] = {}
    window_frames: Optional[Tuple[int, Optional[int]]] = None
    if ANALYSIS_WINDOW_SECONDS is not None and sample_rate:
        start_sec, end_sec = ANALYSIS_WINDOW_SECONDS
        abs_start = max(0, int(math.floor(float(start_sec) * sample_rate)))
        abs_end = None if end_sec is None else int(math.ceil(float(end_sec) * sample_rate))
        window_frames = (abs_start, abs_end)

    session_frame_offset = 0
    for segment_index, segment_files in grouped_entries.items():
        segment_result = process_segment(
            segment_index,
            analysis_manifest,
            sample_rate,
            segment_files,
            output_folder,
            eda_method,
            progress=progress,
            logger=logger,
            session_frame_offset=session_frame_offset,
            window_frames=window_frames,
        )

        for channel in segment_result.get("channels", []):
            if isinstance(channel, dict):
                signal_kind = channel.get("signalKind", "generic")
                signal_kind_counts[signal_kind] = signal_kind_counts.get(signal_kind, 0) + 1

        segment_results.append(segment_result)
        total_frames += int(segment_result.get("frameCount", 0) or 0)
        session_frame_offset += int(segment_result.get("rawFrameCount", segment_result.get("frameCount", 0)) or 0)
        total_chunks += len(segment_files)

    biosppy_strategy = ["ecg", "eda", "ppg", "emg", "rsp", "eeg", "pcg", "acc"]
    neurokit2_strategy = ["ecg", "eda", "ppg", "emg", "rsp", "eog", "eeg", "hrv"]

    library_versions = detect_library_versions()
    preprocessing_block: Optional[Dict[str, Any]] = None
    if build_preprocessing_block is not None:
        present_kinds = sorted(k for k in signal_kind_counts if k and k != "generic")
        try:
            preprocessing_block = build_preprocessing_block(
                library_versions.get("biosppy"),
                library_versions.get("neurokit2"),
                signal_kinds=present_kinds or None,
            )
        except Exception:
            preprocessing_block = None

    return {
        "sessionId": manifest.get("sessionId"),
        "sessionFolder": str(session_folder),
        "sampleRate": sample_rate,
        "chunkCount": total_chunks,
        "analyzedAt": now_iso(),
        "completedAt": now_iso(),
        "worker": {
            "name": "python-analysis-worker",
            "biosppyAvailable": process_biosppy_signal is not None,
            "neurokit2Available": nk is not None,
            "libraryStrategy": {
                "summary": library_policy["summary"],
                "biosppy": biosppy_strategy,
                "neurokit2": neurokit2_strategy,
            },
        },
        "analysisPolicy": library_policy,
        **({"preprocessing": preprocessing_block} if preprocessing_block is not None else {}),
        "analysisConfig": {
            "batchMode": "load-session-process-entire-dataset-store-features",
            "channelSignalKinds": analysis_manifest.get("channelSignalKinds", {}),
            "channelSignalAxes": analysis_manifest.get("channelSignalAxes", {}),
            **({"eegChannels": analysis_manifest.get("eegChannels", [])} if analysis_manifest.get("eegChannels") else {}),
            "signalKindOverrides": selected_signal_kinds,
            "signalAxisOverrides": selected_signal_axes,
            "excludedChannels": sorted(EXCLUDED_CHANNELS),
            "libraryPreference": SELECTED_LIBRARY_PREFERENCE or "auto",
            "signalKindLibraries": dict(SIGNAL_KIND_LIBRARY_PREFERENCES),
            "edaMethod": eda_method or "neurokit2-default",
            **(
                {"analysisWindow": {"startSec": ANALYSIS_WINDOW_SECONDS[0], "endSec": ANALYSIS_WINDOW_SECONDS[1]}}
                if ANALYSIS_WINDOW_SECONDS is not None
                else {}
            ),
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
                    "median",
                    "std",
                    "min",
                    "max",
                    "libraries",
                    "seriesPath",
                    "preprocessing",
                    "outlierRemoval",
                ]
            )
        for segment in result.get("segments", []):
            segment_index = segment.get("segment") if isinstance(segment, dict) else None
            for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
                if not isinstance(channel, dict):
                    continue

                summary = channel.get("summary", {})
                analysis = channel.get("analysis", {})
                preprocessing = channel.get("preprocessing")
                if preprocessing is None and isinstance(analysis, dict):
                    preprocessing = analysis.get("preprocessing")
                outlier_removal = channel.get("outlierRemoval")
                if outlier_removal is None and isinstance(analysis, dict):
                    outlier_removal = analysis.get("outlierRemoval")
                writer.writerow(
                    [
                        segment_index,
                        channel.get("channel"),
                        channel.get("label"),
                        channel.get("signalKind"),
                        summary.get("count"),
                        summary.get("mean"),
                        summary.get("median"),
                        summary.get("std"),
                        summary.get("min"),
                        summary.get("max"),
                        ",".join(analysis.get("libraries", []))
                        if isinstance(analysis.get("libraries"), list)
                        else "",
                        channel.get("seriesPath"),
                        json.dumps(sanitize_for_json(preprocessing), ensure_ascii=False),
                        json.dumps(sanitize_for_json(outlier_removal), ensure_ascii=False),
                    ]
                )



def _compact_meta_value(value: Any, max_list: int = 25) -> Any:
    if isinstance(value, dict):
        return {key: _compact_meta_value(item, max_list) for key, item in value.items()}
    if isinstance(value, list):
        if len(value) > max_list:
            return f"<{len(value)} items omitted — see analysis.json>"
        return [_compact_meta_value(item, max_list) for item in value]
    return value


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

                # Export preprocessing and outlierRemoval metadata as special 'meta' rows
                preprocessing = channel.get("preprocessing")
                if preprocessing is None:
                    preprocessing = analysis.get("preprocessing")
                if preprocessing is not None:
                    writer.writerow(
                        [
                            segment_index,
                            channel.get("channel"),
                            channel.get("label"),
                            channel.get("signalKind"),
                            "meta",
                            "preprocessing",
                            json.dumps(_compact_meta_value(sanitize_for_json(preprocessing)), ensure_ascii=False),
                        ]
                    )

                outlier = channel.get("outlierRemoval")
                if outlier is None:
                    outlier = analysis.get("outlierRemoval")
                if outlier is not None:
                    writer.writerow(
                        [
                            segment_index,
                            channel.get("channel"),
                            channel.get("label"),
                            channel.get("signalKind"),
                            "meta",
                            "outlierRemoval",
                            json.dumps(_compact_meta_value(sanitize_for_json(outlier)), ensure_ascii=False),
                        ]
                    )

                for library, feature_key in [("biosppy", "biosppyFeatures"), ("neurokit2", "neurokit2Features"), ("derived", "derivedFeatures")]:
                    features = analysis.get(feature_key, {})
                    if not isinstance(features, dict):
                        continue

                    for feature_name, value in sorted(features.items(), key=lambda item: item[0]):
                        if "ts" in feature_name.split("_"):
                            continue

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


def _signal_kinds_in_features(output_folder: Path) -> List[str]:
    """Read the distinct signal kinds present in features.csv (column index 3)."""
    features_path = output_folder / "features.csv"
    if not features_path.exists():
        return []
    try:
        csv.field_size_limit(10 ** 7)
    except Exception:
        pass
    kinds: set = set()
    try:
        with features_path.open("r", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            next(reader, None)
            for row in reader:
                if len(row) < 4:
                    continue
                kind = (row[3] or "").strip().lower()
                if kind:
                    kinds.add(kind)
    except Exception:
        return []
    return sorted(kinds)


def _describe_pp_filter(value: Any) -> str:
    """Render a filter spec from preprocessing_metadata into a readable phrase."""
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        return str(value)
    if "stages" in value:
        stage_text = "; then ".join(_describe_pp_filter(stage) for stage in value["stages"])
        if value.get("zero_phase"):
            stage_text += " (zero-phase)"
        return stage_text
    parts: List[str] = []
    if value.get("type"):
        parts.append(str(value["type"]))
    if value.get("band"):
        parts.append(str(value["band"]))
    descriptor = " ".join(parts)
    extras: List[str] = []
    if value.get("order") is not None:
        extras.append(f"order {value['order']}")
    cutoff = value.get("cutoff_hz")
    if cutoff is not None:
        if isinstance(cutoff, (list, tuple)):
            extras.append(f"{cutoff[0]}-{cutoff[1]} Hz")
        else:
            extras.append(f"{cutoff} Hz")
    if value.get("split_cutoff_hz") is not None:
        extras.append(f"split at {value['split_cutoff_hz']} Hz")
    text = descriptor
    if extras:
        text = f"{descriptor}, {', '.join(extras)}" if descriptor else ", ".join(extras)
    return text or "see library defaults"


def _format_pp_value(key: str, value: Any) -> str:
    if key == "filter":
        return _describe_pp_filter(value)
    if isinstance(value, dict):
        bits: List[str] = []
        for k, v in value.items():
            if k == "filter":
                bits.append(_describe_pp_filter(v))
            elif isinstance(v, (list, tuple)):
                bits.append(f"{k}: {', '.join(str(x) for x in v)}")
            elif isinstance(v, dict):
                bits.append(f"{k}: {_format_pp_value(k, v)}")
            else:
                bits.append(f"{k}: {v}")
        return "; ".join(bits)
    if isinstance(value, (list, tuple)):
        return ", ".join(str(x) for x in value)
    return str(value)


def append_preprocessing_readme_section(output_folder: Path) -> None:
    """Append a 'Preprocessing' section to README.md spelling out what BioSPPy and
    NeuroKit2 do, by default, before extracting features."""
    if get_preprocessing_metadata is None:
        return
    readme_path = output_folder / "README.md"
    kinds = _signal_kinds_in_features(output_folder)
    if not kinds:
        return

    versions = detect_library_versions()
    bv, nv = versions.get("biosppy"), versions.get("neurokit2")

    rendered: List[str] = []
    _base_keys = {
        "library", "requested_version", "reference_version",
        "exact_version_match", "signal_kind", "status",
    }
    label_map = {"biosppy": "BioSPPy", "neurokit2": "NeuroKit2"}

    for kind in kinds:
        kind_blocks: List[str] = []
        for library, version in (("biosppy", bv), ("neurokit2", nv)):
            meta = get_preprocessing_metadata(library, version, kind)
            if "status" in meta:  # no documented metadata for this kind/library
                continue
            lines = [f"#### {label_map.get(library, library)}\n"]
            for key, value in meta.items():
                if key in _base_keys:
                    continue
                lines.append(f"- **{key}**: {_format_pp_value(key, value)}\n")
            kind_blocks.append("".join(lines))
        if kind_blocks:
            rendered.append(f"### {kind.upper()}\n\n" + "\n".join(kind_blocks))

    if not rendered:
        return

    version_note_parts = []
    if bv:
        version_note_parts.append(f"BioSPPy {bv}")
    if nv:
        version_note_parts.append(f"NeuroKit2 {nv}")
    version_note = f" ({', '.join(version_note_parts)})" if version_note_parts else ""

    header = [
        "## Preprocessing (what the libraries do by default)\n",
        "Before any feature is extracted, each signal is filtered/cleaned by the "
        "analysis libraries using their **default** routines" + version_note + ". "
        "The worker does not override those internal pipelines (only EDA's cleaning "
        "method is configurable via `--eda-method`). The exact methods and filter "
        "parameters per library, per signal kind, are listed below and recorded "
        "machine-readably in `analysis.json` under `preprocessing`.\n",
        "**Ordering.** The worker first drops non-finite samples and, for "
        "ECG/EDA/PPG/EMG/RSP/EOG, applies the NeuroKit2 `<kind>_clean` default once; "
        "that cleaned series is then passed to **both** libraries, each of which "
        "filters again internally. EEG/PCG/ACC receive only finite-value "
        "sanitization. The per-channel steps actually run are recorded in each "
        "channel's `preprocessing.steps` field in `analysis.json`.\n",
    ]

    try:
        with readme_path.open("a", encoding="utf-8") as rh:
            rh.write("\n".join(header))
            rh.write("\n")
            rh.write("\n".join(rendered))
            rh.write("\n")
    except Exception:
        # Non-fatal: don't break analysis if README append fails
        pass


def append_features_readme_section(output_folder: Path) -> None:
    """Append a human-readable 'Features extracted' section to README.md describing
    the features present in `features.csv` grouped by library. """
    features_path = output_folder / "features.csv"
    readme_path = output_folder / "README.md"
    if not features_path.exists():
        return

    try:
        csv.field_size_limit(10 ** 7)
    except Exception:
        pass

    by_kind: Dict[str, Dict[str, set]] = {}
    try:
        with features_path.open("r", encoding="utf-8") as fh:
            reader = csv.reader(fh)
            header = next(reader, None)
            for row in reader:
                if len(row) < 6:
                    continue
                kind = (row[3] or "").strip().lower() or "unknown"
                lib = row[4] or "unknown"
                feat = (row[5] or "").strip()
                if not feat:
                    continue
                if "ts" in feat.split("_"):
                    continue
                by_kind.setdefault(kind, {}).setdefault(lib, set()).add(feat)
    except Exception:
        return

    common: Dict[str, str] = {
        # NeuroKit2 HRV metrics (common)
        "HRV_RMSSD": "Root Mean Square of Successive Differences of RR intervals (ms) - short-term HRV.",
        "HRV_SDNN": "Standard deviation of NN intervals (ms) - HRV overall variability.",
        "HRV_LF": "Low-frequency spectral power (Hz) component of HRV.",
        "HRV_HF": "High-frequency spectral power (Hz) component of HRV.",
        "HRV_LFHF": "Ratio of LF to HF power - balance of autonomic tone.",
        "HRV_PAS": "Probability-based or pseudospectral HRV metric (library-specific); consult NeuroKit2 docs for exact definition.",
        "HRV_window_count": "Number of 5-min windows HRV was computed over.",
        "PRV_window_count": "Number of 5-min windows pulse-rate variability (PRV) was computed over.",

        # BioSPPy / signal-level (common outputs)
        "ts": "Time axis for the processed signal (seconds).",
        # Generic fallback; per-kind `filtered` overrides in by_kind_desc carry the
        # signal-specific filter band. The stat-suffix logic (_mean/_std/…) resolves
        # `filtered_*` against whichever `filtered` description applies for the kind.
        "filtered": "Filtered version of the raw signal (library-specific filtering).",

        # BioSPPy ECG outputs
        "rpeaks": "Indices of detected R-peaks in the ECG signal.",
        "templates_ts": "Time axis for heartbeat templates (seconds, template-aligned).",
        "templates": "Extracted heartbeat templates aligned on R-peaks.",
        "heart_rate_ts": "Time axis for instantaneous heart rate samples (seconds).",
        "heart_rate": "Instantaneous heart rate (beats per minute).",
        "rpeaks_count": "Number of detected R-peaks in the ECG signal.",

        # BioSPPy ECG additional waveform positions
        "Q_positions": "Estimated Q-wave sample indices across templates.",
        "Q_start_positions": "Estimated Q-wave start indices.",
        "S_positions": "Estimated S-wave sample indices across templates.",
        "S_end_positions": "Estimated S-wave end indices.",
        "P_positions": "Estimated P-wave sample indices across templates.",
        "P_start_positions": "Estimated P-wave start indices.",
        "P_end_positions": "Estimated P-wave end indices.",
        "T_positions": "Estimated T-wave sample indices across templates.",
        "T_start_positions": "Estimated T-wave start indices.",
        "T_end_positions": "Estimated T-wave end indices.",

        # BioSPPy EDA outputs
        "edr": "Electrodermal Response (phasic) component of the EDA signal.",
        "edl": "Electrodermal Level (tonic) component of the EDA signal.",
        "onsets": "Detected SCR onset sample indices.",
        "peaks": "Detected SCR peak sample indices.",
        "amplitudes": "SCR pulse amplitudes (peak - preceding trough).",
        "phasic_rate": "Phasic SCR rate (events per 60s) or per-window value.",
        "rise_times": "Time from SCR onset to peak (seconds).",
        "half_rec": "Half-recovery time (seconds) for SCR pulses.",
        "six_rec": "63% recovery time (seconds) for SCR pulses.",

        # NeuroKit2 EDA / SCR features
        "SCR_Peaks": "Sample indices of detected Skin Conductance Response (SCR) peaks.",
        "SCR_Onsets": "Sample indices where each SCR begins (onset).",
        "SCR_Height": "Skin conductance level at each SCR peak.",
        "SCR_Amplitude": "Amplitude of each SCR (rise above the tonic level).",
        "SCR_RiseTime": "Time from SCR onset to peak (seconds).",
        "SCR_RecoveryTime": "Time from SCR peak to half-amplitude recovery (seconds).",
        "SCR_Recovery": "Sample indices of SCR half-recovery points.",
        "sampling_rate": "Sampling rate used for the analysis (Hz).",

        # (PPG-specific outputs — peaks/onsets/templates/segments_loc/params —
        # live in `by_kind_desc["ppg"]` because their names collide with EDA/PCG.)

        # BioSPPy Respiration outputs
        "zeros": "Indices of respiration zero-crossings (cycle boundaries).",
        "resp_rate_ts": "Time axis for respiration rate samples (seconds).",
        "resp_rate": "Instantaneous respiration rate (Hz).",
        "resp_rate_mean": "Mean respiration rate over the interval.",

        # BioSPPy EEG band-power outputs (per time window, per channel)
        "theta": "Theta-band (4-8 Hz) power over time windows.",
        "alpha_low": "Low alpha-band (8-10 Hz) power over time windows.",
        "alpha_high": "High alpha-band (10-13 Hz) power over time windows.",
        "beta": "Beta-band (13-25 Hz) power over time windows.",
        "gamma": "Gamma-band (25-40 Hz) power over time windows.",
        "plf": "Phase-Locking Factor between EEG channel pairs.",
        "plf_pairs": "Channel index pairs used for the phase-locking factor.",
        # (EEG-specific 'filtered' override lives in by_kind_desc["eeg"].)

        # NeuroKit2 EEG band powers (nk.eeg_power, per channel)
        "EEG_Power_Delta": "NeuroKit2 EEG power in the delta band (0.5-4 Hz).",
        "EEG_Power_Theta": "NeuroKit2 EEG power in the theta band (4-8 Hz).",
        "EEG_Power_Alpha": "NeuroKit2 EEG power in the alpha band (8-13 Hz).",
        "EEG_Power_Beta": "NeuroKit2 EEG power in the beta band (13-30 Hz).",
        "EEG_Power_Gamma": "NeuroKit2 EEG power in the gamma band (30-45 Hz).",
        # NeuroKit2 EMG features
        "EMG_Raw": "Raw EMG signal samples (preprocessed).",
        "EMG_Clean": "Cleaned EMG signal after filtering/detrending.",
        "EMG_Amplitude": "Linear envelope of the EMG (activation amplitude).",
        "EMG_Activity": "Binary activity mask (1 when amplitude > threshold).",
        "EMG_Onsets": "Detected onset samples for EMG activations.",
        "EMG_Offsets": "Detected offset samples for EMG activations.",
        "EMG_Activation_N": "Number of detected activation bursts in the interval.",
        "EMG_Amplitude_Mean": "Mean amplitude of detected EMG activations.",
        "EMG_Amplitude_SD": "Standard deviation of EMG activation amplitudes.",
        "EMG_Amplitude_Max": "Maximum activation amplitude observed.",
        "EMG_Amplitude_Max_Time": "Time/sample index of the maximum activation amplitude.",
        "EMG_Bursts": "Count of EMG bursts (activations) in the epoch/interval.",

        # Derived EMG features (computed per sliding window on the cleaned signal,
        # 'derived' library). Each feature is computed per overlapping window; the
        # _mean/_std/_min/_max suffixes summarize it across all windows, and the
        # full per-window series is in emg_windows/<channel>.csv.
        "EMG_MAV": "Mean Absolute Value (Hudgins) - average rectified amplitude of the cleaned EMG, per window.",
        "EMG_RMS": "Root Mean Square (Hudgins) - signal power / amplitude of the cleaned EMG, per window.",
        "EMG_WL": "Waveform Length (Hudgins) - cumulative length of the signal waveform (sum of |Δsample|), per window.",
        "EMG_ZC": "Zero Crossings (Hudgins) - number of times the cleaned signal changes sign, per window.",
        "EMG_SSC": "Slope Sign Changes (Hudgins) - number of times the slope (first difference) changes sign, per window.",
        "EMG_MNF": "Mean (power) Frequency (Hz) - power-weighted average frequency of the Welch PSD; a fatigue indicator, per window.",
        "EMG_MDF": "Median Frequency (Hz) - frequency splitting the Welch PSD power into two halves; a fatigue indicator, per window.",
        "EMG_window_count": "Number of sliding windows the EMG features were computed over.",

        # NeuroKit2 RSP / respiration features
        "RSP_Raw": "Raw respiration belt signal samples.",
        "RSP_Clean": "Cleaned respiration signal after preprocessing.",
        "RSP_Peaks": "Detected exhalation peak samples (marked as 1 in a vector).",
        "RSP_Troughs": "Detected inhalation trough samples (marked as 1 in a vector).",
        "RSP_Rate": "Instantaneous respiration rate interpolated between peaks (breaths/min).",
        "RSP_Amplitude": "Interpolated respiratory amplitude per breath.",
        "RSP_Phase": "Binary respiratory phase signal (1=inspiration, 0=expiration).",
        "RSP_Phase_Completion": "Fractional completion of current respiratory phase (0..1).",
        "RSP_RVT": "Respiratory Volume per Time (RVT) — volume*time index per sample.",
        "RSP_Rate_Mean": "Mean respiration rate over the analyzed interval.",
        "RSP_Rate_SD": "Standard deviation of respiration rate over the interval.",

        # Respiratory Rate Variability (RRV) metrics (rsp_rrv)
        "RRV_SDBB": "Standard deviation of breath-to-breath intervals (ms).",
        "RRV_RMSSD": "Root mean square of successive differences of breath intervals (ms).",
        "RRV_SDSD": "Standard deviation of successive differences of breath intervals.",
        "RRV_BBx": "Count of successive interval differences greater than x seconds.",
        "RRV_pBBx": "Proportion of successive interval differences greater than x seconds.",
        "RRV_VLF": "Very-low-frequency spectral power of respiratory rate variability.",
        "RRV_LF": "Low-frequency spectral power of respiratory rate variability.",
        "RRV_HF": "High-frequency spectral power of respiratory rate variability.",
        "RRV_LFHF": "Ratio of LF to HF power in respiratory rate variability.",
        "RRV_LFn": "Normalized low-frequency power (RRV).",
        "RRV_HFn": "Normalized high-frequency power (RRV).",
        "RRV_SD1": "Poincaré plot short-term variability (SD1) of breath intervals.",
        "RRV_SD2": "Poincaré plot long-term variability (SD2) of breath intervals.",
        "RRV_SD2SD1": "Ratio SD2/SD1 — long-to-short term variability ratio.",
        "RRV_DFA_alpha1": "Detrended Fluctuation Analysis alpha1 (short-term fractal scaling).",
        "RRV_DFA_alpha2": "Detrended Fluctuation Analysis alpha2 (long-term fractal scaling).",
        "RRV_ApEn": "Approximate entropy of respiratory rate variability.",
        "RRV_SampEn": "Sample entropy of respiratory rate variability.",
    }

    # Per-signal-kind descriptions. These take priority over `common`, so they
    # disambiguate shared keys (ts/filtered/onsets/peaks/amplitudes/heart_rate)
    # whose meaning differs per signal, and document each kind's BioSPPy and
    # NeuroKit2 outputs. HRV_*/PRV_* (NeuroKit2-only) stay in `common`.
    by_kind_desc: Dict[str, Dict[str, str]] = {
        "ecg": {
            # BioSPPy (biosppy.signals.ecg.ecg)
            "ts": "Time axis of the BioSPPy-filtered ECG (seconds).",
            "filtered": "Band-pass filtered ECG signal (BioSPPy, FIR ~3-45 Hz).",
            "rpeaks": "Sample indices of detected R-peaks (BioSPPy Hamilton segmenter).",
            "templates": "Extracted heartbeat templates aligned on R-peaks (BioSPPy).",
            "templates_ts": "Time axis for the heartbeat templates (seconds).",
            "heart_rate": "Instantaneous heart rate from successive RR intervals (bpm, BioSPPy).",
            "heart_rate_ts": "Time axis for the instantaneous heart-rate samples (seconds).",
            # NeuroKit2 (nk.ecg_process; HRV_* from nk.hrv are in `common`)
            "ECG_Clean": "Cleaned ECG (NeuroKit2 default: ~0.5 Hz high-pass Butterworth + powerline notch).",
            "ECG_R_Peaks": "Sample indices of detected R-peaks (NeuroKit2).",
            "ECG_Rate": "Instantaneous heart rate interpolated per sample (bpm, NeuroKit2).",
            "ECG_Quality": "Per-sample ECG signal-quality index (NeuroKit2).",
        },
        "eda": {
            # BioSPPy (biosppy.signals.eda.eda)
            "ts": "Time axis of the BioSPPy-filtered EDA (seconds).",
            "filtered": "Filtered EDA signal (BioSPPy).",
            "onsets": "Detected SCR onset sample indices (BioSPPy).",
            "peaks": "Detected SCR peak sample indices (BioSPPy).",
            "amplitudes": "SCR amplitudes at the detected peaks (BioSPPy).",
            # NeuroKit2 (nk.eda_process; SCR_* are in `common`)
            "EDA_Clean": "Cleaned EDA signal (NeuroKit2).",
            "EDA_Tonic": "Tonic EDA component / skin-conductance level (SCL) (NeuroKit2).",
            "EDA_Phasic": "Phasic EDA component / skin-conductance response driver (NeuroKit2).",
        },
        "ppg": {
            # BioSPPy (biosppy.signals.ppg.ppg)
            "ts": "Time axis of the BioSPPy-filtered PPG (seconds).",
            "filtered": "Filtered PPG signal (BioSPPy).",
            "onsets": "PPG pulse onset indices (start of beats, BioSPPy).",
            "peaks": "Indices of detected PPG pulse (systolic) peaks (BioSPPy).",
            "templates": "Extracted PPG pulse templates aligned on systolic peaks (BioSPPy).",
            "segments_loc": "Start/end indices for each PPG pulse segment (BioSPPy).",
            "params": "Auxiliary parameters returned by some peak/onset functions (BioSPPy).",
            "heart_rate": "Instantaneous pulse rate from successive PPG peaks (bpm, BioSPPy).",
            "heart_rate_ts": "Time axis for the instantaneous pulse-rate samples (seconds).",
            # NeuroKit2 (nk.ppg_process; PRV_* map to the HRV_* descriptions in `common`)
            "PPG_Clean": "Cleaned PPG signal (NeuroKit2).",
            "PPG_Peaks": "Sample indices of detected systolic peaks (NeuroKit2).",
            "PPG_Rate": "Instantaneous pulse rate interpolated per sample (bpm, NeuroKit2).",
            "PPG_Quality": "Per-sample PPG signal-quality index (NeuroKit2).",
        },
        "emg": {
            # BioSPPy (biosppy.signals.emg.emg)
            "ts": "Time axis of the BioSPPy-filtered EMG (seconds).",
            "filtered": "Filtered/rectified EMG signal (BioSPPy).",
            "onsets": "Detected EMG activation onset sample indices (BioSPPy threshold detector).",
            # NeuroKit2 (nk.emg_process). Windowed Hudgins/MNF/MDF features are in
            # `common` under the 'derived' library; these are the nk.emg_process outputs.
            "EMG_Clean": "Cleaned EMG signal (NeuroKit2: high-pass + rectify).",
            "EMG_Amplitude": "Linear envelope of the EMG / activation amplitude (NeuroKit2).",
            "EMG_Activity": "Binary activation mask (1 where amplitude exceeds threshold) (NeuroKit2).",
            "EMG_Onsets": "Detected activation onset samples (NeuroKit2).",
            "EMG_Offsets": "Detected activation offset samples (NeuroKit2).",
        },
        "rsp": {
            # BioSPPy (biosppy.signals.resp.resp)
            "ts": "Time axis of the BioSPPy-filtered respiration (seconds).",
            "filtered": "Band-pass filtered respiration signal (BioSPPy, ~0.1-0.35 Hz).",
            "zeros": "Respiration zero-crossing indices / cycle boundaries (BioSPPy).",
            "resp_rate": "Instantaneous respiration rate (Hz, BioSPPy).",
            "resp_rate_ts": "Time axis for the respiration-rate samples (seconds).",
            # NeuroKit2 (nk.rsp_process; RRV_* are in `common`)
            "RSP_Clean": "Cleaned respiration signal (NeuroKit2).",
            "RSP_Peaks": "Detected exhalation peak samples (NeuroKit2).",
            "RSP_Troughs": "Detected inhalation trough samples (NeuroKit2).",
            "RSP_Rate": "Instantaneous respiration rate (breaths/min, NeuroKit2).",
            "RSP_Amplitude": "Per-breath respiratory amplitude (NeuroKit2).",
        },
        "eeg": {
            # BioSPPy (biosppy.signals.eeg.eeg)
            "ts": "Time axis of the BioSPPy-filtered EEG (seconds).",
            "filtered": "Band-pass filtered EEG signal (~4-40 Hz by default: 4 Hz high-pass order-8 + 40 Hz low-pass order-16 Butterworth).",
            "theta": "Theta-band (4-8 Hz) power over time windows (BioSPPy).",
            "alpha_low": "Low alpha-band (8-10 Hz) power over time windows (BioSPPy).",
            "alpha_high": "High alpha-band (10-13 Hz) power over time windows (BioSPPy).",
            "beta": "Beta-band (13-25 Hz) power over time windows (BioSPPy).",
            "gamma": "Gamma-band (25-40 Hz) power over time windows (BioSPPy).",
            "plf": "Phase-locking factor between EEG channel pairs (BioSPPy).",
            "plf_pairs": "Channel index pairs used for the phase-locking factor (BioSPPy).",
            # NeuroKit2 (nk.eeg_power)
            "EEG_Power_Delta": "NeuroKit2 EEG power in the delta band (0.5-4 Hz).",
            "EEG_Power_Theta": "NeuroKit2 EEG power in the theta band (4-8 Hz).",
            "EEG_Power_Alpha": "NeuroKit2 EEG power in the alpha band (8-13 Hz).",
            "EEG_Power_Beta": "NeuroKit2 EEG power in the beta band (13-30 Hz).",
            "EEG_Power_Gamma": "NeuroKit2 EEG power in the gamma band (30-45 Hz).",
        },
        "pcg": {
            # BioSPPy (biosppy.signals.pcg.pcg) - no NeuroKit2 PCG support
            "ts": "Time axis of the BioSPPy-filtered PCG (seconds).",
            "filtered": "Filtered phonocardiogram signal (BioSPPy).",
            "peaks": "Indices of detected heart-sound peaks (BioSPPy).",
            "heart_sounds": "Classified heart sounds, e.g. S1/S2 (BioSPPy).",
            "heart_rate": "Heart rate derived from heart-sound intervals (bpm, BioSPPy).",
        },
        "acc": {
            # BioSPPy (biosppy.signals.acc.acc) - no NeuroKit2 ACC support
            "ts": "Time axis of the BioSPPy-processed acceleration (seconds).",
            "filtered": "Filtered per-axis acceleration signal (BioSPPy).",
            "signal": "Processed per-axis acceleration signal (BioSPPy).",
            "vm": "Vector magnitude of the 3-axis acceleration (BioSPPy, version-dependent).",
        },
        "eog": {
            # NeuroKit2 (nk.eog_process) + custom _extract_eog_features - no BioSPPy EOG
            "EOG_Clean": "Cleaned EOG signal (NeuroKit2).",
            "EOG_Blinks": "Sample indices of detected blinks (NeuroKit2).",
            "EOG_Rate": "Blink-rate signal interpolated per sample (NeuroKit2).",
            "EOG_Blinks_count": "Total number of detected blinks.",
            "EOG_Blink_Rate_per_min": "Blink rate (blinks per minute).",
            "EOG_IBI_Mean_s": "Mean inter-blink interval (seconds).",
            "EOG_IBI_SD_s": "Standard deviation of inter-blink intervals (seconds).",
            "EOG_Rate_Mean": "Mean of the per-sample blink-rate signal.",
            "EOG_Rate_SD": "Standard deviation of the per-sample blink-rate signal.",
            "EOG_Rate_Min": "Minimum of the per-sample blink-rate signal.",
            "EOG_Rate_Max": "Maximum of the per-sample blink-rate signal.",
        },
    }

    stat_suffixes = ("_mean", "_std", "_median", "_min", "_max", "_count")

    def describe(feature: str, kind: str) -> str:
        kind_map = by_kind_desc.get(kind, {})

        def lookup(name: str) -> Optional[str]:
            if name in kind_map:
                return kind_map[name]
            if name in common:
                return common[name]
            if name.startswith("PRV_"):
                hrv_desc = common.get(f"HRV_{name[4:]}")
                if hrv_desc is not None:
                    return hrv_desc.replace("HRV", "PRV").replace("RR intervals", "pulse-to-pulse intervals")
            return None

        direct = lookup(feature)
        if direct is not None:
            return direct
        for suffix in stat_suffixes:
            if feature.endswith(suffix):
                base = feature[: -len(suffix)]
                base_desc = lookup(base)
                if base_desc is not None:
                    return f"{suffix[1:].capitalize()} of: {base_desc}"
        return "See NeuroKit2 or BioSPPy docs."

    lines: List[str] = []
    lines.append("## Features extracted by analysis\n")
    lines.append("This section lists the features written to `features.csv` during analysis, grouped by signal kind and the library that produced them. Short descriptions are provided where available.\n")

    for kind in sorted(by_kind.keys()):
        lines.append(f"### {kind.upper()}\n")
        for lib, feats in sorted(by_kind[kind].items()):
            lines.append(f"#### {lib}\n")
            for feat in sorted(feats):
                desc = describe(feat, kind)
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
    result_sample_rate = result.get("sampleRate") or 0
    for segment in result.get("segments", []):
        segment_index = segment.get("segment") if isinstance(segment, dict) else None
        sample_rate = (segment.get("sampleRate") if isinstance(segment, dict) else None) or result_sample_rate
        segment_folder = segment_artifact_folder(output_folder, segment_index)
        segment_folder.mkdir(parents=True, exist_ok=True)

        for channel in segment.get("channels", []) if isinstance(segment, dict) else []:
            if not isinstance(channel, dict):
                continue

            export_name = channel.get("_export_name") or channel.get("channel")

            if "_indices" in channel and "_values" in channel:
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

            analysis = channel.get("analysis")
            if isinstance(analysis, dict) and "_emgWindows" in analysis:
                windows = analysis.pop("_emgWindows")
                if isinstance(windows, list) and windows:
                    channel["emgWindowsPath"] = export_emg_windows_csv(
                        segment_folder, export_name, windows
                    )

            if isinstance(analysis, dict) and "_hrvWindows" in analysis:
                hrv_windows = analysis.pop("_hrvWindows")
                if isinstance(hrv_windows, list) and hrv_windows:
                    is_prv = (channel.get("signalKind") or "").lower() == "ppg"
                    subdir = "prv_windows" if is_prv else "hrv_windows"
                    channel["hrvWindowsPath"] = export_hrv_windows_csv(
                        segment_folder, export_name, hrv_windows, subdir
                    )

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

        #{'API version': ..., 'Channels': [...], 'Channels indexes raw': [...],
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
    
    if ANALYSIS_SEGMENT is not None:
        grouped = {ANALYSIS_SEGMENT: grouped.get(ANALYSIS_SEGMENT, [])}

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
            "Channels indexes raw": [(n - 1) + 5 for n in channel_numbers],
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

        segment_folder = segment_artifact_folder(output_folder, segment_index)
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
    logger = AnalysisLogger(
        output_folder / "analysis-log.csv",
        session_folder=session_folder,
        output_folder=output_folder,
        session_name=session_folder.name,
    )
    startup_started = time.perf_counter()
    config = load_run_config(args)
    global DISABLE_OUTLIER_REMOVAL, SELECTED_LIBRARY_PREFERENCE, SIGNAL_KIND_LIBRARY_PREFERENCES
    global SIGNAL_KIND_OVERRIDES, SIGNAL_AXIS_OVERRIDES, EXCLUDED_CHANNELS, ANALYSIS_WINDOW_SECONDS
    global ANALYSIS_SEGMENT, EMG_WINDOW_MS, EMG_WINDOW_STEP_MS, HRV_WINDOW_SEC, HRV_WINDOW_STEP_SEC
    DISABLE_OUTLIER_REMOVAL = bool(config.get("disableOutlierRemoval", False))
    SELECTED_LIBRARY_PREFERENCE = config.get("libraryPreference")
    SIGNAL_KIND_LIBRARY_PREFERENCES = dict(config.get("signalKindLibraries", {}))
    SIGNAL_KIND_OVERRIDES = dict(config.get("signalKinds", {}))
    SIGNAL_AXIS_OVERRIDES = dict(config.get("signalAxes", {}))
    EXCLUDED_CHANNELS = set(config.get("excludedChannels", []))
    ANALYSIS_WINDOW_SECONDS = config.get("range")
    ANALYSIS_SEGMENT = config.get("segment")
    EMG_WINDOW_MS = config.get("emgWindowMs", DEFAULT_EMG_WINDOW_MS)
    EMG_WINDOW_STEP_MS = config.get("emgWindowStepMs", DEFAULT_EMG_WINDOW_STEP_MS)
    HRV_WINDOW_SEC = config.get("hrvWindowSec", DEFAULT_HRV_WINDOW_SEC)
    HRV_WINDOW_STEP_SEC = config.get("hrvWindowStepSec", DEFAULT_HRV_WINDOW_STEP_SEC)

    eda_method = SELECTED_LIBRARY_PREFERENCE or "auto"
    session_name = session_folder.name

    try:
        logger.log_message(
            "[analysis] worker startup and configuration loaded",
            step="startup",
            duration_ms=(time.perf_counter() - startup_started) * 1000.0,
            libraryPreference=SELECTED_LIBRARY_PREFERENCE or "auto",
            disableOutlierRemoval=DISABLE_OUTLIER_REMOVAL,
        )

        analysis_started = time.perf_counter()
        with logger.step("analysis", "Processing signals"):
            result, progress = build_result(
                session_folder,
                output_folder,
                eda_method,
                logger=logger,
            )
        analyze_seconds = time.perf_counter() - analysis_started
        chunk_count = int(result.get("chunkCount") or 0)
        frame_count = int(result.get("frameCount") or 0)
        sample_rate = result.get("sampleRate")
        sample_rate_suffix = f" @ {sample_rate}Hz" if sample_rate else ""
        logger.log_message(
            f"[analysis][{session_name}] analysis phase done in {analyze_seconds:.2f}s, writing outputs...",
            step="analysis",
            duration_ms=analyze_seconds * 1000.0,
            chunkCount=chunk_count,
            frameCount=frame_count,
        )
        progress.emit("Writing output files", force=True)

        with logger.step("write_channel_series", "Writing per-channel series CSVs"):
            write_channel_series_csvs(output_folder, result)

        try:
            with logger.step("write_signal_csvs", "Writing sense.py-format signal CSVs"):
                signal_csvs = write_signal_csvs(output_folder, session_folder, result)
            if signal_csvs:
                logger.log_message(
                    f"[analysis][{session_name}] wrote {len(signal_csvs)} sense.py-format signal CSV(s)",
                    step="write_signal_csvs",
                    signalCsvCount=len(signal_csvs),
                )
        except Exception as exc:
            logger.log_message(
                f"[analysis][{session_name}] WARNING: could not write sense.py-format signal CSV(s): {exc}",
                step="write_signal_csvs",
                status="warning",
                error=str(exc),
            )

        with logger.step("write_readme", "Writing analysis README"):
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

        with logger.step("write_analysis_json", "Writing analysis.json and CSV summaries"):
            result = prune_bulky_arrays(result)
            result = sanitize_for_json(result)
            result_path = output_folder / "analysis.json"
            write_summary_csv(output_folder, result)
            write_features_csv(output_folder, result)
            try:
                append_preprocessing_readme_section(output_folder)
            except Exception:
                pass
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
            logger.log_message(
                f"[{session_name}] done in {total_seconds:.2f}s "
                f"(analysis {analyze_seconds:.2f}s + outputs {total_seconds - analyze_seconds:.2f}s) "
                f"— {chunk_count} chunks, {frame_count} frames"
                f"{sample_rate_suffix} (library={eda_method}, "
                f"result.json={result_size_mb:.1f}MB)",
                step="complete",
                duration_ms=total_seconds * 1000.0,
                resultSizeMb=result_size_mb,
            )
        else:
            result_size_mb = result_path.stat().st_size / (1024) 
            logger.log_message(
                f"[{session_name}] done in {total_seconds:.2f}s "
                f"(analysis {analyze_seconds:.2f}s + outputs {total_seconds - analyze_seconds:.2f}s) "
                f"— {chunk_count} chunks, {frame_count} frames"
                f"{sample_rate_suffix} (library={eda_method}, "
                f"result.json={result_size_mb:.1f}KB)",
                step="complete",
                duration_ms=total_seconds * 1000.0,
                resultSizeKb=result_size_mb,
            )
        logger.close()
        return 0
    except Exception as exc:
        import traceback as _traceback
        _trace = _traceback.format_exc()
        # Emit full traceback for debugging in dev runs
        try:
            sys.stderr.write(_trace + "\n")
        except Exception:
            pass
        error = {
            "error": str(exc),
            "sessionFolder": str(session_folder),
            "outputFolder": str(output_folder),
            "failedAt": now_iso(),
            "trace": _trace,
        }
        try:
            logger.log_message(
                f"[analysis][{session_name}] FAILED: {exc}",
                step="error",
                status="error",
                error=str(exc),
            )
        except Exception:
            pass
        try:
            logger.close()
        except Exception:
            pass
        sys.stderr.write(json.dumps(error, ensure_ascii=False))
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
