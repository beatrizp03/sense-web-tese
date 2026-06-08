#!/usr/bin/env python3
"""Benchmark NeuroKit2 EDA decomposition methods on representative sessions.

The script runs the post-hoc analysis worker twice per session:

- once with the default cvxEDA-style decomposition
- once with a fast override (smoothmedian by default)

It then compares wall-clock runtime and the overlap of the EDA-specific
NeuroKit2 outputs recorded in analysis-result.json.

Usage examples:

    python benchmark_eda_methods.py
    python benchmark_eda_methods.py --session-folder apps/sense-desktop/data/synthetic-set1
    python benchmark_eda_methods.py --methods cvxEDA smoothmedian --report-path benchmark.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "data"
ANALYSIS_WORKER = SCRIPT_DIR / "analysis_worker.py"
DEFAULT_METHODS = ("cvxEDA", "smoothmedian")


@dataclass
class MethodRun:
    method: str
    elapsed_seconds: float
    output_folder: Path
    result: Dict[str, Any]


@dataclass(frozen=True)
class EDARecordKey:
    segment: Any
    channel: Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare runtime and EDA feature agreement between NeuroKit2 methods",
    )
    parser.add_argument(
        "--session-folder",
        action="append",
        dest="session_folders",
        default=[],
        help="Session folder to benchmark. May be repeated. Defaults to all discovered synthetic sessions with EDA.",
    )
    parser.add_argument(
        "--methods",
        nargs=2,
        metavar=("BASELINE", "FAST"),
        default=list(DEFAULT_METHODS),
        help="Two NeuroKit2 method names to compare. Default: cvxEDA smoothmedian",
    )
    parser.add_argument(
        "--report-path",
        default=None,
        help="Optional JSON file to write the benchmark report to.",
    )
    return parser.parse_args()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def resolve_session_folder(raw_path: str) -> Path:
    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Session folder does not exist: {path}")
    if not path.is_dir():
        raise NotADirectoryError(f"Session folder is not a directory: {path}")
    manifest_path = path / "session.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing session manifest: {manifest_path}")
    return path


def session_has_eda(session_folder: Path) -> bool:
    try:
        manifest = load_json(session_folder / "session.json")
    except Exception:
        return False

    channel_kinds = manifest.get("channelSignalKinds")
    if not isinstance(channel_kinds, dict):
        return False

    for kind in channel_kinds.values():
        if isinstance(kind, str) and kind.strip().lower() == "eda":
            return True
    return False


def discover_sessions() -> List[Path]:
    candidates: List[Path] = []
    if DATA_DIR.exists():
        for child in sorted(DATA_DIR.iterdir(), key=lambda path: path.name.lower()):
            if not child.is_dir():
                continue
            if not child.name.startswith("synthetic-"):
                continue
            if (child / "session.json").exists() and session_has_eda(child):
                candidates.append(child)
    return candidates


def run_analysis(session_folder: Path, method: str, temp_root: Path) -> MethodRun:
    output_folder = temp_root / session_folder.name / method
    output_folder.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["SENSE_ANALYSIS_EDA_METHOD"] = method

    print(f"Running {session_folder.name} with {method}...", flush=True)
    start = time.perf_counter()
    completed = subprocess.run(
        [sys.executable, str(ANALYSIS_WORKER), "--session-folder", str(session_folder), "--output-folder", str(output_folder)],
        cwd=str(SCRIPT_DIR),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    elapsed_seconds = time.perf_counter() - start

    if completed.returncode != 0:
        raise RuntimeError(
            f"analysis_worker.py failed for {session_folder.name} with method={method}:\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )

    result_path = output_folder / "analysis-result.json"
    if not result_path.exists():
        raise FileNotFoundError(f"Benchmark run did not produce {result_path}")

    return MethodRun(method=method, elapsed_seconds=elapsed_seconds, output_folder=output_folder, result=load_json(result_path))


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def numeric_summary(values: Sequence[float]) -> Dict[str, float]:
    clean = [float(value) for value in values if not (isinstance(value, float) and (math.isnan(value) or math.isinf(value)))]
    if not clean:
        return {}
    if len(clean) == 1:
        value = clean[0]
        return {"len": 1.0, "mean": value, "std": 0.0, "min": value, "max": value}

    avg = mean(clean)
    variance = sum((value - avg) ** 2 for value in clean) / len(clean)
    return {
        "len": float(len(clean)),
        "mean": avg,
        "std": math.sqrt(variance),
        "min": min(clean),
        "max": max(clean),
    }


def flatten_metrics(value: Any, prefix: str = "") -> Dict[str, float]:
    metrics: Dict[str, float] = {}

    if isinstance(value, dict):
        for key in sorted(value.keys(), key=str):
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            metrics.update(flatten_metrics(value[key], child_prefix))
        return metrics

    if isinstance(value, (list, tuple)):
        if not value:
            return metrics

        numeric_values = [item for item in value if is_number(item)]
        if len(numeric_values) == len(value):
            if len(value) <= 32:
                for index, item in enumerate(value):
                    metrics[f"{prefix}[{index}]"] = float(item)
            else:
                summary = numeric_summary(numeric_values)
                for key, item in summary.items():
                    metrics[f"{prefix}.{key}"] = float(item)
            return metrics

        for index, item in enumerate(value):
            child_prefix = f"{prefix}[{index}]" if prefix else f"[{index}]"
            metrics.update(flatten_metrics(item, child_prefix))
        return metrics

    if is_number(value):
        metrics[prefix or "value"] = float(value)

    return metrics


def collect_paths(value: Any, prefix: str = "") -> set[str]:
    paths: set[str] = set()

    if isinstance(value, dict):
        for key in sorted(value.keys(), key=str):
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            child_paths = collect_paths(value[key], child_prefix)
            if child_paths:
                paths.update(child_paths)
            else:
                paths.add(child_prefix)
        return paths

    if isinstance(value, (list, tuple)):
        if not value:
            if prefix:
                paths.add(prefix)
            return paths
        for index, item in enumerate(value):
            child_prefix = f"{prefix}[{index}]" if prefix else f"[{index}]"
            child_paths = collect_paths(item, child_prefix)
            if child_paths:
                paths.update(child_paths)
            else:
                paths.add(child_prefix)
        return paths

    if prefix:
        paths.add(prefix)
    return paths


def collect_eda_records(result: Dict[str, Any]) -> Dict[EDARecordKey, Dict[str, Any]]:
    records: Dict[EDARecordKey, Dict[str, Any]] = {}
    for segment in result.get("segments", []):
        if not isinstance(segment, dict):
            continue
        segment_index = segment.get("segment")
        for channel in segment.get("channels", []):
            if not isinstance(channel, dict):
                continue
            analysis = channel.get("analysis", {})
            if not isinstance(analysis, dict):
                continue
            if channel.get("signalKind") != "eda" and analysis.get("signalKind") != "eda":
                continue
            nk_block = analysis.get("neurokit2", {})
            if not isinstance(nk_block, dict):
                continue
            key = EDARecordKey(segment=segment_index, channel=channel.get("channel"))
            records[key] = {
                "segment": segment_index,
                "channel": channel.get("channel"),
                "label": channel.get("label"),
                "signalKind": channel.get("signalKind"),
                "signalsColumns": nk_block.get("signalsColumns", []),
                "info": nk_block.get("info", {}),
                "warnings": analysis.get("warnings", []),
            }
    return records


def compare_runs(baseline: MethodRun, fast: MethodRun, session_folder: Path) -> Dict[str, Any]:
    baseline_records = collect_eda_records(baseline.result)
    fast_records = collect_eda_records(fast.result)

    shared_keys = sorted(set(baseline_records) & set(fast_records), key=lambda item: (str(item.segment), str(item.channel)))
    record_count = len(shared_keys)

    per_channel: List[Dict[str, Any]] = []
    shared_metric_values: List[Tuple[float, float]] = []
    shared_metric_keys = 0
    shared_info_keys = 0
    total_info_key_union = 0
    signals_columns_match = True

    for key in shared_keys:
        base_record = baseline_records[key]
        fast_record = fast_records[key]

        base_metrics = flatten_metrics(base_record.get("info", {}))
        fast_metrics = flatten_metrics(fast_record.get("info", {}))
        base_info_paths = collect_paths(base_record.get("info", {}))
        fast_info_paths = collect_paths(fast_record.get("info", {}))
        shared_keys = sorted(set(base_metrics) & set(fast_metrics))
        shared_info_keys += len(shared_keys)
        total_info_key_union += len(base_info_paths | fast_info_paths)

        channel_pairs: List[Tuple[float, float]] = []
        for key in shared_keys:
            base_value = base_metrics[key]
            fast_value = fast_metrics[key]
            if math.isfinite(base_value) and math.isfinite(fast_value):
                shared_metric_values.append((base_value, fast_value))
                channel_pairs.append((base_value, fast_value))

        base_columns = list(base_record.get("signalsColumns") or [])
        fast_columns = list(fast_record.get("signalsColumns") or [])
        columns_match = base_columns == fast_columns
        signals_columns_match = signals_columns_match and columns_match

        per_channel.append(
            {
                "segment": base_record.get("segment"),
                "channel": base_record.get("channel"),
                "label": base_record.get("label"),
                "baseMetricKeys": len(base_metrics),
                "fastMetricKeys": len(fast_metrics),
                "sharedMetricKeys": len(shared_keys),
                "baseInfoKeys": len(base_info_paths),
                "fastInfoKeys": len(fast_info_paths),
                "sharedInfoKeys": len(base_info_paths & fast_info_paths),
                "signalsColumnsMatch": columns_match,
                "warningCountBaseline": len(base_record.get("warnings", []) or []),
                "warningCountFast": len(fast_record.get("warnings", []) or []),
            }
        )
        shared_metric_keys += len(channel_pairs)

    if shared_metric_values:
        abs_diffs = [abs(base_value - fast_value) for base_value, fast_value in shared_metric_values]
        rel_diffs = [abs(base_value - fast_value) / max(abs(base_value), abs(fast_value), 1e-9) for base_value, fast_value in shared_metric_values]
        agreement = {
            "sharedNumericMetricCount": len(shared_metric_values),
            "meanAbsoluteError": sum(abs_diffs) / len(abs_diffs),
            "meanRelativeError": sum(rel_diffs) / len(rel_diffs),
            "maxAbsoluteError": max(abs_diffs),
            "maxRelativeError": max(rel_diffs),
        }
    else:
        agreement = {
            "sharedNumericMetricCount": 0,
            "meanAbsoluteError": None,
            "meanRelativeError": None,
            "maxAbsoluteError": None,
            "maxRelativeError": None,
        }

    return {
        "sessionFolder": str(session_folder),
        "baselineMethod": baseline.method,
        "fastMethod": fast.method,
        "baselineSeconds": baseline.elapsed_seconds,
        "fastSeconds": fast.elapsed_seconds,
        "speedup": baseline.elapsed_seconds / fast.elapsed_seconds if fast.elapsed_seconds > 0 else None,
        "edaChannelCount": len(baseline_records),
        "signalsColumnsMatch": signals_columns_match,
        "sharedInfoKeyCount": shared_info_keys,
        "infoKeyUnionCount": total_info_key_union,
        "infoKeyOverlap": shared_info_keys / total_info_key_union if total_info_key_union else None,
        "sharedMetricValueCount": shared_metric_keys,
        "agreement": agreement,
        "channels": per_channel,
    }


def format_seconds(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}s"


def print_report(report: Dict[str, Any]) -> None:
    print(f"Session: {report['sessionFolder']}")
    speedup_text = f"{report['speedup']:.2f}x" if report.get("speedup") else "n/a"
    print(
        f"  {report['baselineMethod']}: {format_seconds(report['baselineSeconds'])} | "
        f"{report['fastMethod']}: {format_seconds(report['fastSeconds'])} | speedup: {speedup_text}"
    )
    print(
        f"  EDA channels: {report['edaChannelCount']} | "
        f"signalsColumnsMatch={report['signalsColumnsMatch']} | "
        f"sharedInfoKeyCount={report['sharedInfoKeyCount']} | "
        f"sharedNumericMetricCount={report['agreement']['sharedNumericMetricCount']}"
    )
    if report.get("infoKeyOverlap") is not None:
        print(f"  infoKeyOverlap={report['infoKeyOverlap']:.3f}")
    if report["agreement"]["meanRelativeError"] is not None:
        print(
            f"  meanRelativeError={report['agreement']['meanRelativeError']:.6f} | "
            f"maxRelativeError={report['agreement']['maxRelativeError']:.6f}"
        )
    else:
        print("  meanRelativeError=n/a")

    for channel in report.get("channels", []):
        print(
            f"    {channel['channel']}: shared={channel['sharedMetricKeys']} "
            f"columnsMatch={channel['signalsColumnsMatch']}"
        )


def aggregate_reports(reports: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    total_baseline = sum(float(report["baselineSeconds"]) for report in reports)
    total_fast = sum(float(report["fastSeconds"]) for report in reports)
    speedup = total_baseline / total_fast if total_fast > 0 else None

    all_numeric_agreements = [
        report["agreement"] for report in reports if report["agreement"]["sharedNumericMetricCount"] > 0
    ]
    if all_numeric_agreements:
        relative_values = [item["meanRelativeError"] for item in all_numeric_agreements if item["meanRelativeError"] is not None]
        absolute_values = [item["meanAbsoluteError"] for item in all_numeric_agreements if item["meanAbsoluteError"] is not None]
        mean_relative_error = sum(relative_values) / len(relative_values) if relative_values else None
        mean_absolute_error = sum(absolute_values) / len(absolute_values) if absolute_values else None
    else:
        mean_relative_error = None
        mean_absolute_error = None

    return {
        "sessionCount": len(reports),
        "totalBaselineSeconds": total_baseline,
        "totalFastSeconds": total_fast,
        "speedup": speedup,
        "meanRelativeError": mean_relative_error,
        "meanAbsoluteError": mean_absolute_error,
        "allSignalsColumnsMatch": all(report["signalsColumnsMatch"] for report in reports) if reports else True,
    }


def main() -> int:
    args = parse_args()
    if not ANALYSIS_WORKER.exists():
        raise FileNotFoundError(f"Missing analysis worker: {ANALYSIS_WORKER}")

    methods = list(args.methods)
    baseline_method, fast_method = methods[0], methods[1]

    if args.session_folders:
        session_folders = [resolve_session_folder(path) for path in args.session_folders]
    else:
        session_folders = discover_sessions()

    if not session_folders:
        raise FileNotFoundError(
            "No EDA-containing synthetic sessions were found. Generate one under apps/sense-desktop/data first."
        )

    reports: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="eda-benchmark-") as temp_dir:
        temp_root = Path(temp_dir)
        for session_folder in session_folders:
            baseline = run_analysis(session_folder, baseline_method, temp_root)
            fast = run_analysis(session_folder, fast_method, temp_root)
            report = compare_runs(baseline, fast, session_folder)
            reports.append(report)
            print_report(report)

        aggregate = aggregate_reports(reports)
        final_report = {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "methods": methods,
            "sessions": reports,
            "aggregate": aggregate,
        }

        print("\nAggregate:")
        aggregate_speedup = f"{aggregate['speedup']:.2f}x" if aggregate.get("speedup") else "n/a"
        print(
            f"  sessions={aggregate['sessionCount']} | "
            f"totalBaseline={format_seconds(aggregate['totalBaselineSeconds'])} | "
            f"totalFast={format_seconds(aggregate['totalFastSeconds'])} | speedup={aggregate_speedup}"
        )
        print(f"  allSignalsColumnsMatch={aggregate['allSignalsColumnsMatch']}")
        if aggregate["meanRelativeError"] is not None:
            print(
                f"  meanRelativeError={aggregate['meanRelativeError']:.6f} | "
                f"meanAbsoluteError={aggregate['meanAbsoluteError']:.6f}"
            )

        if args.report_path:
            report_path = Path(args.report_path).expanduser().resolve()
            report_path.parent.mkdir(parents=True, exist_ok=True)
            with report_path.open("w", encoding="utf-8") as handle:
                json.dump(final_report, handle, indent=2, ensure_ascii=False)
            print(f"\nWrote report to {report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())