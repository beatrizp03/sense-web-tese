#!/usr/bin/env python3
"""Minimal CSV logger for analysis runs.

Writes one CSV row per event with a timestamp, elapsed_ms, event (step),
event_duration_ms and an optional message/details JSON string.
"""

from __future__ import annotations

import csv
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, Optional


class AnalysisLogger:
    def __init__(
        self,
        output_path: Path,
        *,
        session_folder: Optional[Path] = None,
        output_folder: Optional[Path] = None,
        session_name: Optional[str] = None,
        flush: bool = False,
    ) -> None:
        self.output_path = Path(output_path)
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.session_folder = str(session_folder) if session_folder is not None else ""
        self.output_folder = str(output_folder) if output_folder is not None else ""
        self.session_name = session_name or ""
        self.started_at = time.perf_counter()
        self._handle = None
        self._writer = None
        self._flush = bool(flush)

    @staticmethod
    def _to_event_token(text: str) -> str:
        token = []
        prev_sep = False
        for char in (text or "").strip().lower():
            if char.isalnum():
                token.append(char)
                prev_sep = False
            else:
                if not prev_sep:
                    token.append("_")
                    prev_sep = True
        normalized = "".join(token).strip("_")
        return normalized or "event"

    def _map_event_name(self, *, step: str = "", label: str = "", message: str = "") -> str:
        source = (label or message or step or "event").strip().lower()
        if "loading chunks and parsing data" in source:
            return "loading_files"
        if "data preparation complete" in source:
            return "data_prepared"
        if "writing output files" in source:
            return "writing_outputs"
        if "csv summaries written" in source:
            return "csv_written"
        if "initializing analysis" in source:
            return "initializing_analysis"
        if "filtering & segmentation" in source:
            return "filtering_segmentation"
        if "detecting peaks & features" in source:
            return "detecting_peaks_features"
        if "processing &" in source:
            return "processing"
        if source.endswith(" complete") or " done in " in source:
            return "complete"
        return self._to_event_token(step or label or message)

    def _ensure_open(self) -> None:
        if self._handle is not None:
            return

        self._handle = self.output_path.open("w", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(
            self._handle,
            fieldnames=["timestamp", "elapsed_ms", "event", "event_duration_ms", "message"],
        )
        self._writer.writeheader()

    def _write_row(
        self,
        event: str,
        duration_ms: Optional[float] = None,
        message: str = "",
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._ensure_open()
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "elapsed_ms": round((time.perf_counter() - self.started_at) * 1000.0, 3),
            "event": event,
            "event_duration_ms": "" if duration_ms is None else round(duration_ms, 3),
            "message": message,
        }
        assert self._writer is not None
        self._writer.writerow(payload)
        if self._flush:
            try:
                self._handle.flush()
            except Exception:
                pass

    def _write_event_pair(self, event: str, message: str, duration_ms: Optional[float] = None) -> None:
        started = time.perf_counter()
        self._write_row(f"{event}_start", message=message)
        elapsed_ms = (time.perf_counter() - started) * 1000.0 if duration_ms is None else duration_ms
        self._write_row(f"{event}_end", duration_ms=elapsed_ms, message=message)

    def log_message(self, message: str, *, step: str = "", duration_ms: Optional[float] = None, **details: Any) -> None:
        event = self._map_event_name(step=step, message=message)
        # keep printing for backward compatibility with UI
        print(message, flush=True)
        self._write_event_pair(event, message, duration_ms=duration_ms)

    def log_progress(self, percentage: int, label: str, *, step: str = "progress", **details: Any) -> None:
        message = f"[progress] {percentage}% {label}"
        event = self._map_event_name(step=step, label=label, message=message)
        print(message, flush=True)
        self._write_event_pair(event, message)

    @contextmanager
    def step(self, step: str, message: Optional[str] = None, **details: Any) -> Iterator[None]:
        label = message or step.replace("_", " ").strip().capitalize()
        event = self._map_event_name(step=step, label=label)
        started = time.perf_counter()
        self._write_row(f"{event}_start", message=label)
        try:
            yield
        except Exception as exc:
            duration_ms = (time.perf_counter() - started) * 1000.0
            self._write_row(f"{event}_end", duration_ms=duration_ms, message=f"{label} failed: {exc}")
            raise
        else:
            duration_ms = (time.perf_counter() - started) * 1000.0
            self._write_row(f"{event}_end", duration_ms=duration_ms, message=label)

    def close(self) -> None:
        if self._handle is not None:
            try:
                self._handle.flush()
            except Exception:
                pass
            try:
                self._handle.close()
            except Exception:
                pass
            self._handle = None
            self._writer = None

    def __enter__(self) -> "AnalysisLogger":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
