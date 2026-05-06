"""Generate a 1-channel synthetic SENSE session for a single signal kind.

Defaults to 7200s (2h) at 1 kHz so the resulting folder is a realistic
stress test for the analysis worker on long recordings.

The session has exactly one channel ("AI1") mapped to the requested kind —
unlike make_synthetic_session.py, no flat-zero filler channels are added.

Usage:
    python make_single_channel_session.py <kind>
    python make_single_channel_session.py ecg --duration 60 --sample-rate 500
    python make_single_channel_session.py ecg --duration 1800 --sample-rate 1000 --name synthetic-1ch-ecg-1800s

Supported kinds: ecg, eda, ppg, emg, rsp, eog, eeg, pcg, acc

"""

from __future__ import annotations

import argparse
from pathlib import Path

from make_synthetic_session import (
    DEFAULT_CHUNK_SIZE,
    DEFAULT_SAMPLE_RATE,
    SUPPORTED_KINDS,
    simulate,
    write_session,
)

DEFAULT_DURATION = 7200


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("kind", choices=SUPPORTED_KINDS)
    parser.add_argument(
        "--duration", type=int, default=DEFAULT_DURATION,
        help=f"Seconds of signal (default: {DEFAULT_DURATION})",
    )
    parser.add_argument(
        "--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE,
        help=f"Sampling rate in Hz (default: {DEFAULT_SAMPLE_RATE})",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE,
        help=f"Frames per chunk file (default: {DEFAULT_CHUNK_SIZE})",
    )
    parser.add_argument("--name", default=None, help="Override the session folder name")
    args = parser.parse_args()

    if args.chunk_size <= 0:
        parser.error("--chunk-size must be a positive integer")

    base_dir = Path(__file__).resolve().parent.parent / "data"
    base_dir.mkdir(parents=True, exist_ok=True)

    folder_name = args.name or f"synthetic-1ch-{args.kind}"
    session_dir = base_dir / folder_name

    expected_chunks = max(
        1,
        (args.duration * args.sample_rate + args.chunk_size - 1) // args.chunk_size,
    )
    print(
        f"Generating 1-channel '{args.kind}' session — "
        f"{args.duration}s @ {args.sample_rate}Hz, "
        f"chunk_size={args.chunk_size} (~{expected_chunks} chunk file(s))"
    )

    signal = simulate(args.kind, args.duration, args.sample_rate)
    chunk_count, frame_count = write_session(
        session_dir=session_dir,
        session_id=folder_name,
        sample_rate=args.sample_rate,
        channels=["AI1"],
        channel_signal_kinds={"AI1": args.kind},
        signals={"AI1": signal},
        chunk_size=args.chunk_size,
    )
    print(f"  wrote {chunk_count} chunk file(s) covering {frame_count} frames")
    print(f"  session folder: {session_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
