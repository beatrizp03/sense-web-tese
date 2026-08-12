"""
check_lost_frames_updated.py - validate frame continuity in a ScientISST session.

Data-integrity check from the project spec: load the acquired data into memory,
verify that the index increments are unitary (equivalently: the discrete
derivative of the index column is 1 everywhere), and treat any other value as
sample loss. This runs against the session's chunked JSON/NDJSON files - the
format the SENSE acquisition pipeline writes - rather than a post-analysis CSV;
the data and the check are identical, only the on-disk format differs.

It extends that basic check by validating two independent counters, per chunk
file and across files within a segment:

  __seq     BufferManager monotonic counter (0, 1, 2, ...; no wrap; resets per segment)
            → detects frames dropped between IPC send and disk write
  sequence  Device-native NSeq (wraps every `modulo` frames, e.g. 0–15)
            → detects frames dropped at the device / transmission level

The check is the same for both fields: take the discrete difference between
consecutive values of the field and verify it is always 1 (modulo the wrap size,
for `sequence`). Any other value means samples were lost - the step size minus 1
is the number of lost frames.

Usage:
    python check_lost_frames_updated.py <session_folder> [--seq-modulo N]

    --seq-modulo N   NSeq wrap-around size (default: auto-detect from the data,
                     falls back to 16 for ScientISST's 4-bit counter)

Note vs. check_lost_frames.py: both the per-file and the cross-file totals now
count *lost frames* (step − 1, summed), so the summary's "frame(s) lost" figure
is consistent. The original counted per-file gaps as events (one per gap, no
matter how many frames the gap spanned) while counting transitions as frames.
"""

import os
import json
import sys
import argparse


# --- loading ---------------------------------------------------------------

def load_frames(filepath):
    """Load one chunk file into memory (JSON array, {"frames": [...]}, or NDJSON)."""
    with open(filepath, "r") as f:
        content = f.read()
    if filepath.endswith(".ndjson"):
        return [json.loads(line) for line in content.splitlines() if line.strip()]
    data = json.loads(content)
    if isinstance(data, dict) and "frames" in data:
        return data["frames"]
    return data


def get_session_chunks(session_path):
    """Return [(filepath, segment_number), ...] from session.json, in file order.

    session.json stores each chunk's path differently depending on who wrote it:
    synthetic sessions store a bare filename ("sample1_chunk0.json"), real
    sessions written by the BufferManager store the absolute path it had at
    recording time (which goes stale if the folder is later moved). In every
    case the chunk file sits directly inside the session folder, so we resolve
    by filename against that folder and only fall back to the stored path if the
    file isn't found there.
    """
    session_dir = os.path.dirname(session_path)
    with open(session_path, "r") as f:
        session = json.load(f)
    chunks = session.get("chunks", [])
    if not chunks:
        sys.exit("No chunks found in session.json")

    resolved = []
    for c in chunks:
        in_folder = os.path.join(session_dir, os.path.basename(c["file"]))
        resolved.append((in_folder if os.path.exists(in_folder) else c["file"],
                         c.get("segment", 1)))
    return resolved


# --- sequence checking -----------------------------------------------------
#
# step(a, b) is the "discrete derivative": the difference between two
# consecutive sequence values. For the wrapping device counter we take it
# modulo the wrap size, so 15 → 0 reads as a step of 1, not -15.

def step(a, b, modulo=None):
    return (b - a) % modulo if modulo else b - a


def _tag(tag):
    """Left-pad the '[__seq]' / '[seq]' label so the two columns line up."""
    return f"[{tag}]".ljust(8)


def _print_gaps(gaps, corrupt, tag, label, modulo):
    """Print a 'no gaps' line, or the first few anomalies plus '...and N more'."""
    where = f" (modulo={modulo})" if modulo else ""
    if not gaps and not corrupt:
        print(f"  {_tag(tag)}✅ No gaps inside {label}{where}")
        return

    if corrupt:
        print(f"  {_tag(tag)}⚠️  {len(corrupt)} corrupted value(s) inside {label}{where}:")
        for i, prev, bad, nxt in corrupt[:3]:
            print(f"          frame {i}: {prev} → {bad} → {nxt}  (implausible; counted as 1 bad frame, not {step(1, step(prev, bad, modulo), modulo)} lost)")
        if len(corrupt) > 3:
            print(f"          ...and {len(corrupt) - 3} more")

    if gaps:
        print(f"  {_tag(tag)}❌ {len(gaps)} gap(s) inside {label}{where}:")
        for i, prev, curr, d in gaps[:5]:
            print(f"          frame {i}: {prev} → {curr}  (diff={d}, lost={step(1, d, modulo)})")
        if len(gaps) > 5:
            print(f"          ...and {len(gaps) - 5} more")


def check_internal(frames, label, field, tag, modulo=None):
    """Check that `field` steps by exactly 1 within a single file.

    This is the discrete-derivative test: take the difference between
    consecutive values of the index column and require it to be 1 everywhere.

    For the wrapping device counter a further distinction is needed, because a
    single corrupted value produces two anomalies, one into it and one out of
    it, and scoring both as loss inflates the total by orders of magnitude. A
    frame whose neighbours step by exactly 2 across it is a corrupted value, not
    thousands of missing frames. A step implying a loss of more than half the
    wrap size cannot be distinguished from a smaller one anyway - the counter
    has already wrapped - so it is reported as suspect rather than quantified.

    Returns (lost_frame_count, corrupt_count, suspect_count, first, last).
    """
    seqs = [f[field] for f in frames if field in f]
    if not seqs:
        print(f"  {_tag(tag)}⚠️  No '{field}' field found in {label}")
        return 0, 0, 0, None, None

    anomalies = {i: d for i, (a, b) in enumerate(zip(seqs, seqs[1:]))
                 if (d := step(a, b, modulo)) != 1}

    corrupt = []
    bridged_loss = 0
    if modulo:
        # A corrupted value at index i+1 breaks the step twice: i→i+1 and
        # i+1→i+2. If the counter either side of it is still consistent - that
        # is, i→i+2 spans a plausible distance - then the run is intact and only
        # that one value is wrong. The span tells us how many frames the pair
        # really accounts for: 2 means just the bad frame, more means the bad
        # frame plus genuine losses alongside it.
        for i in sorted(anomalies):
            if i + 1 not in anomalies or i + 2 >= len(seqs):
                continue
            bridge = step(seqs[i], seqs[i + 2], modulo)
            if 2 <= bridge <= modulo // 2 and bridge < max(anomalies[i], anomalies[i + 1]):
                corrupt.append((i + 1, seqs[i], seqs[i + 1], seqs[i + 2]))
                bridged_loss += bridge - 2

    corrupt_at = {i for i, *_ in corrupt}
    skip = corrupt_at | {i - 1 for i in corrupt_at}

    gaps, lost, suspect = [], bridged_loss, 0
    for i, d in sorted(anomalies.items()):
        if i in skip:
            continue
        missing = step(1, d, modulo)
        if modulo and missing > modulo // 2:
            suspect += 1
            continue
        gaps.append((i, seqs[i], seqs[i + 1], d))
        lost += missing

    _print_gaps(gaps, corrupt, tag, label, modulo)
    return lost, len(corrupt), suspect, seqs[0], seqs[-1]


def check_transition(prev_last, curr_first, prev_label, curr_label, tag, modulo=None):
    """Check that `field` is continuous from one file to the next.

    Returns the lost-frame count (0 if continuous, or if there is nothing to
    compare against yet).
    """
    if prev_last is None:
        return 0
    d = step(prev_last, curr_first, modulo)
    edge = f"{os.path.basename(prev_label)} → {os.path.basename(curr_label)}"
    if d == 1:
        print(f"  {_tag(tag)}✅ Transition {edge}: continuous")
        return 0
    lost = step(1, d, modulo)
    print(f"  {_tag(tag)}❌ Transition {edge}: gap! {prev_last} → {curr_first}  (diff={d}, lost={lost})")
    return lost


def detect_modulo(frames_list):
    """Auto-detect the NSeq wrap size from the first wrap point: the value just
    before the wrap, plus 1 (e.g. 15 → 0 means modulo 16). None if it never wraps.
    """
    for frames in frames_list:
        seqs = [f["sequence"] for f in frames if "sequence" in f]
        for a, b in zip(seqs, seqs[1:]):
            if b < a:
                return a + 1
    return None


# --- main ------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Validate ScientISST session frame continuity.")
    parser.add_argument("session_folder", help="Path to session folder containing session.json")
    parser.add_argument("--seq-modulo", type=int, default=None,
                        help="NSeq wrap-around size (default: auto-detect, fallback 16)")
    args = parser.parse_args()

    session_path = os.path.join(args.session_folder, "session.json")
    if not os.path.exists(session_path):
        sys.exit(f"session.json not found in {args.session_folder}")

    chunks = get_session_chunks(session_path)

    # Load everything up front - also lets us auto-detect the device wrap size.
    frames_list = []
    for filepath, _ in chunks:
        try:
            frames_list.append(load_frames(filepath))
        except Exception as e:
            print(f"⚠️  Could not read {filepath}: {e}")
            frames_list.append([])

    if args.seq_modulo is not None:
        modulo, source = args.seq_modulo, "user-specified"
    elif (detected := detect_modulo(frames_list)) is not None:
        modulo, source = detected, "auto-detected"
    else:
        modulo, source = 16, "default fallback"
    print(f"NSeq modulo: {modulo} ({source})\n")

    total_bm_lost = 0
    total_dev_lost = 0
    total_dev_corrupt = 0
    total_dev_suspect = 0
    prev_segment = prev_bm_last = prev_dev_last = prev_filepath = None

    for (filepath, segment), frames in zip(chunks, frames_list):
        label = os.path.basename(filepath)
        print(f"── {label}  (segment {segment}) ──────────────────────")

        if not frames:
            print("  ⚠️  Empty or unreadable file")
            prev_segment, prev_bm_last, prev_dev_last, prev_filepath = segment, None, None, filepath
            continue

        bm_lost, _, _, bm_first, bm_last = check_internal(frames, label, "__seq", "__seq")
        dev_lost, dev_corrupt, dev_suspect, dev_first, dev_last = check_internal(
            frames, label, "sequence", "seq", modulo)
        total_bm_lost += bm_lost
        total_dev_lost += dev_lost
        total_dev_corrupt += dev_corrupt
        total_dev_suspect += dev_suspect

        if prev_segment == segment:
            total_bm_lost += check_transition(prev_bm_last, bm_first, prev_filepath, filepath, "__seq")
            total_dev_lost += check_transition(prev_dev_last, dev_first, prev_filepath, filepath, "seq", modulo)
        elif prev_segment is not None:
            print(f"  [    ] ── Segment boundary {prev_segment} → {segment}, transitions skipped ──")

        prev_segment, prev_bm_last, prev_dev_last, prev_filepath = segment, bm_last, dev_last, filepath
        print()

    bar = "═" * 55
    print(f"{bar}\n  SUMMARY\n{bar}")
    print("  [__seq]  ✅ No frames lost at IPC/buffer level" if total_bm_lost == 0
          else f"  [__seq]  ❌ ~{total_bm_lost} frame(s) lost at IPC/buffer level")
    print("  [seq]    ✅ No frames lost at device/transmission level" if total_dev_lost == 0
          else f"  [seq]    ❌ ~{total_dev_lost} frame(s) lost at device/transmission level")
    if total_dev_corrupt:
        print(f"  [seq]    ⚠️  {total_dev_corrupt} corrupted value(s) - one bad frame each, not lost frames")
    if total_dev_suspect:
        print(f"  [seq]    ⚠️  {total_dev_suspect} step(s) beyond half the wrap size - amount lost cannot be determined")
    print(bar)


if __name__ == "__main__":
    main()
