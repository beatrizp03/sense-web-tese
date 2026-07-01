"""Documented preprocessing parameters per library / version / signal kind.

When the worker runs a library (BioSPPy or NeuroKit2) on a signal, the actual
preprocessing (filtering, peak-detection method, decomposition) is hidden
inside the library's high-level entry point. This module makes those defaults
explicit so the analysis output is self-describing: a year from now, reading
analysis.json, you should be able to tell exactly what was applied to the raw
signal before feature extraction.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


# How the worker actually sequences the libraries.
WORKER_ORDERING = (
    "The worker first drops non-finite samples (all signal kinds) and, for "
    "ecg/eda/ppg/emg/rsp/eog, applies the NeuroKit2 <kind>_clean default once. "
    "That single cleaned series is then handed to BOTH libraries: BioSPPy filters "
    "again inside its entry function, and nk.<kind>_process cleans again "
    "internally. eeg/pcg/acc receive only finite-value sanitization from the "
    "worker. The parameters below are each library's defaults; the per-channel "
    "'preprocessing.steps' field in analysis.json records the steps that actually "
    "ran for that channel."
)

# Signal kinds the worker pre-cleans with NeuroKit2 before either library runs.
NEUROKIT_PRECLEAN_KINDS: Tuple[str, ...] = ("ecg", "eda", "ppg", "emg", "rsp", "eog")

_BIOSPPY_SIGNAL_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "ecg": {
        "entry_function": "biosppy.signals.ecg.ecg",
        "filter": {
            "type": "FIR",
            "band": "bandpass",
            "cutoff_hz": [0.67, 45],
            "order": "int(1.5 * sampling_rate)",
            "window": "hamming",
            "dc_offset_removed": True,
        },
        "peak_detector": "hamilton_segmenter",
        "templates": {
            "window_before_s": 0.2,
            "window_after_s": 0.4,
            "alignment": "R-peak",
        },
        "heart_rate": {
            "computation": "60 / RR-interval, smoothed (size=3)",
            "unit": "bpm",
        },
    },
    "eda": {
        "entry_function": "biosppy.signals.eda.eda",
        "filter": {
            "type": "Butterworth",
            "band": "lowpass",
            "order": 4,
            "cutoff_hz": 5,
        },
        "smoothing": {
            "kernel": "boxzen",
            "size": "int(0.75 * sampling_rate)",
            "mirrored": True,
        },
        "scr_detector": "eda_events(method='emotiphai')",
        "min_amplitude": 0.1,
        "decomposition": {
            "components": ["EDR (phasic)", "EDL (tonic)"],
            "method": "onset-based (biosppy_decomposition)",
        },
    },
    "ppg": {
        "entry_function": "biosppy.signals.ppg.ppg",
        "filter": {
            "type": "Butterworth",
            "band": "bandpass",
            "order": 4,
            "cutoff_hz": [1, 8],
        },
        "onset_detector": "find_onsets_elgendi2013",
        "heart_rate": {
            "computation": "60 / inter-onset interval, smoothed (size=3)",
            "unit": "bpm",
        },
    },
    "emg": {
        "entry_function": "biosppy.signals.emg.emg",
        "filter": {
            "type": "Butterworth",
            "band": "highpass",
            "order": 4,
            "cutoff_hz": 100,
        },
        "onset_detector": (
            "find_onsets (full-wave rectification + moving average; "
            "threshold = 1.2*mean + 2*std)"
        ),
    },
    "rsp": {
        "entry_function": "biosppy.signals.resp.resp",
        "filter": {
            "type": "Butterworth",
            "band": "bandpass",
            "order": 2,
            "cutoff_hz": [0.1, 0.35],
        },
        "rate_method": "zero_crossings",
    },
    "eeg": {
        "entry_function": "biosppy.signals.eeg.eeg",
        "filter": {
            "type": "Butterworth",
            "zero_phase": True,
            "stages": [
                {"band": "highpass", "order": 8, "cutoff_hz": 4},
                {"band": "lowpass", "order": 16, "cutoff_hz": 40},
            ],
        },
        "band_power": {
            "window_s": 0.25,
            "overlap": 0.5,
            "bands_hz": {
                "theta": [4, 8],
                "alpha_low": [8, 10],
                "alpha_high": [10, 13],
                "beta": [13, 25],
                "gamma": [25, 40],
            },
        },
        "connectivity": "phase-locking factor (PLF) between channel pairs",
    },
    "pcg": {
        "entry_function": "biosppy.signals.pcg.pcg",
        "filter": {
            "type": "Butterworth",
            "band": "bandpass",
            "order": 2,
            "cutoff_hz": [25, 400],
        },
        "peak_detector": "homomorphic-envelope peak detection",
        "heart_sound_classification": "S1/S2",
    },
    "acc": {
        "entry_function": "biosppy.signals.acc.acc",
        "filter": "none (raw acceleration)",
        "features": [
            "vector magnitude (VM)",
            "signal magnitude (SM)",
            "frequency-domain features",
            "activity index",
        ],
    },
}


# NeuroKit2 0.2.13 signal defaults.
_NEUROKIT_0_2_13_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "ecg": {
        "entry_function": "neurokit2.ecg_process",
        "clean": {
            "method": "neurokit",
            "filter": {
                "type": "Butterworth",
                "band": "highpass",
                "order": 5,
                "cutoff_hz": 0.5,
            },
            "powerline_filter_hz": 50,
        },
        "peaks": {"method": "neurokit"},
        "hrv": {
            "function": "neurokit2.hrv",
            "domains": ["time", "frequency", "nonlinear"],
            "note": "computed from outlier-corrected peaks; ECG only",
        },
    },
    "eda": {
        "entry_function": "neurokit2.eda_process",
        "clean": {
            "method": "neurokit",
            "filter": {
                "type": "Butterworth",
                "band": "lowpass",
                "order": 4,
                "cutoff_hz": 3,
            },
        },
        "phasic": {
            "method": "highpass",
            "filter": {"type": "Butterworth", "split_cutoff_hz": 0.05},
            "alternatives_available": ["cvxeda", "smoothmedian", "sparse"],
        },
        "peaks": {"method": "neurokit", "amplitude_min": 0.1},
        "worker_option": "--eda-method can switch cleaning/peaks to 'biosppy'",
    },
    "ppg": {
        "entry_function": "neurokit2.ppg_process",
        "clean": {
            "method": "elgendi",
            "filter": {
                "type": "Butterworth",
                "band": "bandpass",
                "order": 2,
                "cutoff_hz": [0.5, 8],
            },
        },
        "peaks": {"method": "elgendi"},
        "hrv": "not derived from PPG in this pipeline (ECG only)",
    },
    "emg": {
        "entry_function": "neurokit2.emg_process",
        "clean": {
            "method": "biosppy",  # NeuroKit2 wraps BioSPPy's EMG filter here
            "filter": {
                "type": "Butterworth",
                "band": "highpass",
                "order": 4,
                "cutoff_hz": 100,
            },
            "detrend": "constant (order 0)",
        },
        "amplitude": {"method": "linear envelope"},
        "activation": {"function": "neurokit2.emg_activation"},
    },
    "rsp": {
        "entry_function": "neurokit2.rsp_process",
        "clean": {
            "method": "khodadad2018",
            "filter": {
                "type": "Butterworth",
                "band": "bandpass",
                "order": 2,
                "cutoff_hz": [0.05, 3],
            },
        },
        "peaks": {"method": "khodadad2018"},
        "rvt": {"method": "harrison2021"},
    },
    "eog": {
        "entry_function": "neurokit2.eog_process",
        "clean": {
            "method": "neurokit",
            "filter": {
                "type": "Butterworth",
                "band": "bandpass",
                "order": 6,
                "cutoff_hz": [0.25, 7.5],
            },
        },
        "peaks": {"method": "mne", "detects": "blinks"},
        "derived": [
            "blink count",
            "blink rate per minute",
            "inter-blink interval mean/SD",
        ],
    },
}


PREPROCESSING_DEFAULTS: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {
    "biosppy": {
        # Same defaults verified for both versions; register both keys so the
        # runtime version (2.1.2 installed / 2.2.4 pinned) is an exact match.
        "2.1.2": _BIOSPPY_SIGNAL_DEFAULTS,
        "2.2.4": _BIOSPPY_SIGNAL_DEFAULTS,
    },
    "neurokit2": {
        "0.2.13": _NEUROKIT_0_2_13_DEFAULTS,
    },
}


_UNKNOWN_LIBRARY_MARKER = "library_not_documented"
_NO_VERSIONS_MARKER = "no_documented_versions_for_this_library"
_NO_METADATA_MARKER = "no_documented_metadata_for_this_signal_kind"


def _version_tuple(version: str) -> Tuple[int, ...]:
    parts: List[int] = []
    for chunk in str(version).split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _resolve_version(
    by_version: Dict[str, Any], requested: Optional[str]
) -> Tuple[Optional[str], bool]:
    if not by_version:
        return None, False
    if requested in by_version:
        return requested, True
    if requested:
        req_mm = _version_tuple(requested)[:2]
        same_minor = [v for v in by_version if _version_tuple(v)[:2] == req_mm]
        if same_minor:
            return sorted(same_minor, key=_version_tuple)[-1], False
    latest = sorted(by_version, key=_version_tuple)[-1]
    return latest, False


def get_preprocessing_metadata(
    library: str, version: Optional[str], signal_kind: str
) -> Dict[str, Any]:
    """Return the documented preprocessing parameters for a library/version/kind."""
    base: Dict[str, Any] = {
        "library": library,
        "requested_version": version,
        "signal_kind": signal_kind,
    }

    by_version = PREPROCESSING_DEFAULTS.get(library)
    if by_version is None:
        return {**base, "status": _UNKNOWN_LIBRARY_MARKER}

    reference_version, exact = _resolve_version(by_version, version)
    if reference_version is None:
        return {**base, "status": _NO_VERSIONS_MARKER}

    base["reference_version"] = reference_version
    base["exact_version_match"] = exact

    metadata = by_version[reference_version].get(signal_kind)
    if metadata is None:
        return {**base, "status": _NO_METADATA_MARKER}

    return {**base, **metadata}


def documented_signal_kinds() -> List[str]:
    """Every signal kind documented for any library (stable, sorted)."""
    kinds = set()
    for by_version in PREPROCESSING_DEFAULTS.values():
        for kind_map in by_version.values():
            kinds.update(kind_map.keys())
    return sorted(kinds)


def build_preprocessing_block(
    biosppy_version: Optional[str],
    neurokit2_version: Optional[str],
    signal_kinds: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Assemble the analysis.json `preprocessing` block: the exact methods and
    filter parameters used, per library, per signal kind, for the versions that
    actually ran."""
    if signal_kinds:
        kinds = [k for k in signal_kinds if k in documented_signal_kinds()]
    if not signal_kinds or not kinds:
        kinds = documented_signal_kinds()

    versions = {"biosppy": biosppy_version, "neurokit2": neurokit2_version}
    per_kind: Dict[str, Any] = {}
    for kind in kinds:
        entry: Dict[str, Any] = {}
        for library, version in versions.items():
            meta = get_preprocessing_metadata(library, version, kind)
            if "status" not in meta:  # documented metadata present
                entry[library] = meta
        if entry:
            per_kind[kind] = entry

    return {
        "summary": (
            "Methods and filter parameters each library applies, by default, "
            "before feature extraction. The worker uses the libraries' high-level "
            "routines with their defaults (only EDA's cleaning method is exposed "
            "via --eda-method)."
        ),
        "library_versions": versions,
        "worker_ordering": WORKER_ORDERING,
        "neurokit2_preclean_kinds": list(NEUROKIT_PRECLEAN_KINDS),
        "signal_kinds": per_kind,
    }
