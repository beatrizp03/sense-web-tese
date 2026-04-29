#!/usr/bin/env python3
"""Unified BioSPPy signal wrapper for post-hoc analysis.

This module provides a stable API around biosppy.signals.* handlers so callers
can process multiple signal kinds using one function and receive a consistent
payload shape.
"""

from __future__ import annotations

import importlib
import math
from statistics import mean, pstdev
from typing import Any, Dict, List, Optional, Sequence

try:
    import numpy as np
except Exception:  # pragma: no cover - runtime dependency in production
    np = None

BIOSPPY_SIGNAL_MAP = {
    "ecg": ("ecg", "ecg"),
    "eda": ("eda", "eda"),
    "ppg": ("ppg", "ppg"),
    "emg": ("emg", "emg"),
    # BioSPPy exposes respiration under resp.resp; rsp is accepted as an alias.
    "rsp": ("resp", "resp"),
    "eeg": ("eeg", "eeg"),
    "pcg": ("pcg", "pcg"),
    "acc": ("acc", "acc")
}

SUPPORTED_SIGNAL_KINDS = set(BIOSPPY_SIGNAL_MAP.keys())

_biosppy_modules: Dict[str, Optional[Any]] = {}
for module_name, _ in set(BIOSPPY_SIGNAL_MAP.values()):
    try:
        _biosppy_modules[module_name] = importlib.import_module(f"biosppy.signals.{module_name}")
    except Exception:
        _biosppy_modules[module_name] = None


def _safe_float(value: Any) -> Optional[float]:
    try:
        converted = float(value)
        if math.isnan(converted) or math.isinf(converted):
            return None
        return converted
    except Exception:
        return None


def _numeric_stats(values: Sequence[float]) -> Dict[str, Any]:
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


def _to_serializable(value: Any) -> Any:
    if value is None:
        return None
    if np is not None and hasattr(value, "tolist"):
        try:
            return value.tolist()
        except Exception:
            return str(value)
    if isinstance(value, dict):
        return {key: _to_serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_serializable(item) for item in value]
    if isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


def _result_to_mapping(result: Any) -> Dict[str, Any]:
    if isinstance(result, dict):
        return result

    for converter_name in ("as_dict", "_asdict"):
        converter = getattr(result, converter_name, None)
        if callable(converter):
            try:
                converted = converter()
                if isinstance(converted, dict):
                    return converted
            except Exception:
                pass

    try:
        converted = dict(result)
        if isinstance(converted, dict):
            return converted
    except Exception:
        pass

    keys_attr = getattr(result, "keys", None)
    if callable(keys_attr):
        try:
            keys = list(keys_attr())
            converted = {key: result[key] for key in keys}
            if isinstance(converted, dict):
                return converted
        except Exception:
            pass

    return {}


def _extract_features(result_mapping: Dict[str, Any]) -> Dict[str, Any]:
    features: Dict[str, Any] = {}
    for key, raw_value in result_mapping.items():
        value = _to_serializable(raw_value)

        if isinstance(value, (int, float)):
            features[key] = value
            continue

        if isinstance(value, list):
            numeric_values: List[float] = []
            for item in value:
                numeric_item = _safe_float(item)
                if numeric_item is not None:
                    numeric_values.append(numeric_item)

            if numeric_values:
                stats = _numeric_stats(numeric_values)
                features[f"{key}_count"] = stats["count"]
                features[f"{key}_mean"] = stats["mean"]
                features[f"{key}_std"] = stats["std"]
                features[f"{key}_min"] = stats["min"]
                features[f"{key}_max"] = stats["max"]
            continue

        if isinstance(value, dict):
            # Keep nested maps as JSON in the analysis result, but exclude them
            # from scalar CSV features unless caller flattens further.
            continue

    return features


def process_signal(signal_kind: str, values: Sequence[float], sample_rate: float) -> Dict[str, Any]:
    normalized_kind = str(signal_kind or "").strip().lower()
    if normalized_kind not in SUPPORTED_SIGNAL_KINDS:
        return {
            "signalKind": normalized_kind or "unknown",
            "library": "biosppy",
            "available": False,
            "features": {},
            "output": None,
            "warnings": [f"Unsupported BioSPPy signal kind: {signal_kind!r}"],
        }

    module_name, function_name = BIOSPPY_SIGNAL_MAP[normalized_kind]
    module = _biosppy_modules.get(module_name)
    if module is None:
        return {
            "signalKind": normalized_kind,
            "library": "biosppy",
            "available": False,
            "features": {},
            "output": None,
            "warnings": [f"BioSPPy module biosppy.signals.{module_name} is unavailable"],
        }

    handler = getattr(module, function_name, None)
    if not callable(handler):
        return {
            "signalKind": normalized_kind,
            "library": "biosppy",
            "available": False,
            "features": {},
            "output": None,
            "warnings": [f"BioSPPy function {function_name} is unavailable in module {module_name}"],
        }

    signal = np.asarray(values, dtype=float) if np is not None else list(values)

    try:
        result = handler(signal=signal, sampling_rate=float(sample_rate), show=False)
        result_mapping = _result_to_mapping(result)
        serializable = (
            _to_serializable(result_mapping)
            if result_mapping
            else {"result": _to_serializable(result)}
        )
        features = _extract_features(result_mapping)

        return {
            "signalKind": normalized_kind,
            "library": "biosppy",
            "available": True,
            "features": features,
            "output": serializable,
            "warnings": [],
        }
    except Exception as exc:
        return {
            "signalKind": normalized_kind,
            "library": "biosppy",
            "available": True,
            "features": {},
            "output": None,
            "warnings": [f"BioSPPy {normalized_kind.upper()} processing failed: {exc}"],
        }
