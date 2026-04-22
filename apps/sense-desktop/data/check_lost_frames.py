"""
check_lost_frames.py — validate frame continuity in a ScientISST session.

Checks two independent sequence fields per chunk/segment:

  __seq     BufferManager monotonic counter (0, 1, 2, ... no wrap, resets per segment)
            → detects frames dropped between IPC send and disk write

  sequence  Device-native NSeq (4-bit, wraps 0-15 every 16 frames)
            → detects frames dropped at the device / transmission level

Usage:
    python check_lost_frames.py <session_folder> [--seq-modulo N]

    --seq-modulo N   NSeq wrap-around size (default: auto-detect from data,
                     falls back to 16 for ScientISST 4-bit)
"""

import os
import json
import sys
import argparse


# ---------------------------------------------------------------------------
# File loading (supports both legacy JSON arrays and NDJSON)
# ---------------------------------------------------------------------------

def load_frames(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    if filepath.endswith('.ndjson'):
        frames = [json.loads(line) for line in content.splitlines() if line.strip()]
    else:
        frames = json.loads(content)
        # legacy format: JSON array OR {frames: [...]}
        if isinstance(frames, dict) and 'frames' in frames:
            frames = frames['frames']
    return frames


def get_session_chunks(session_path):
    with open(session_path, 'r') as f:
        session = json.load(f)
    chunks = session.get('chunks', [])
    if not chunks:
        print("No chunks found in session.json")
        sys.exit(1)
    # Return list of (filepath, segment_number) sorted by segment then file
    return [(c['file'], c.get('segment', 1)) for c in chunks]


# ---------------------------------------------------------------------------
# __seq checks (monotonic, no wrap)
# ---------------------------------------------------------------------------

def check_bm_seq_internal(frames, label):
    """Check that __seq increments by exactly 1 within a file."""
    seqs = [f['__seq'] for f in frames if '__seq' in f]
    if not seqs:
        print(f"  [__seq] ⚠️  No __seq field found in {label}")
        return 0, None, None
    gaps = []
    for i in range(len(seqs) - 1):
        diff = seqs[i + 1] - seqs[i]
        if diff != 1:
            gaps.append((i, seqs[i], seqs[i + 1], diff))
    if gaps:
        print(f"  [__seq] ❌ {len(gaps)} gap(s) inside {label}:")
        for idx, prev, curr, diff in gaps[:5]:
            print(f"          frame {idx}: {prev} → {curr}  (diff={diff}, lost={diff - 1})")
        if len(gaps) > 5:
            print(f"          ...and {len(gaps) - 5} more")
    else:
        print(f"  [__seq] ✅ No gaps inside {label}")
    return len(gaps), seqs[0], seqs[-1]


def check_bm_seq_transition(prev_last, curr_first, prev_label, curr_label):
    """Check that __seq is continuous across two consecutive chunk files."""
    if prev_last is None:
        return 0
    diff = curr_first - prev_last
    if diff == 1:
        print(f"  [__seq] ✅ Transition {os.path.basename(prev_label)} → {os.path.basename(curr_label)}: continuous")
        return 0
    else:
        lost = diff - 1
        print(f"  [__seq] ❌ Transition {os.path.basename(prev_label)} → {os.path.basename(curr_label)}: "
              f"gap! {prev_last} → {curr_first}  (diff={diff}, lost={lost})")
        return abs(lost)


# ---------------------------------------------------------------------------
# device sequence checks (wraps every `modulo` frames)
# ---------------------------------------------------------------------------

def detect_modulo(frames_list):
    """
    Auto-detect NSeq modulo from the data.
    Looks for a wrap point (next < prev); the value just before the wrap + 1 is the modulo.
    Returns None if no wrap is found (session too short to wrap).
    """
    for frames in frames_list:
        seqs = [f['sequence'] for f in frames if 'sequence' in f]
        for i in range(len(seqs) - 1):
            if seqs[i + 1] < seqs[i]:
                return seqs[i] + 1  # e.g., 15 → 0 means modulo = 16
    return None


def check_device_seq_internal(frames, label, modulo):
    """
    Check that the device sequence increments by 1 (mod modulo) within a file.
    A gap means the device dropped or didn't transmit one or more samples.
    """
    seqs = [f['sequence'] for f in frames if 'sequence' in f]
    if not seqs:
        print(f"  [seq]   ⚠️  No 'sequence' field found in {label}")
        return 0, None, None
    gaps = []
    for i in range(len(seqs) - 1):
        diff = (seqs[i + 1] - seqs[i]) % modulo
        if diff != 1:
            gaps.append((i, seqs[i], seqs[i + 1], diff))
    if gaps:
        print(f"  [seq]   ❌ {len(gaps)} gap(s) inside {label} (modulo={modulo}):")
        for idx, prev, curr, diff in gaps[:5]:
            lost = (diff - 1) % modulo
            print(f"          frame {idx}: {prev} → {curr}  (diff={diff} mod {modulo}, lost≈{lost})")
        if len(gaps) > 5:
            print(f"          ...and {len(gaps) - 5} more")
    else:
        print(f"  [seq]   ✅ No gaps inside {label} (modulo={modulo})")
    return len(gaps), seqs[0], seqs[-1]


def check_device_seq_transition(prev_last, curr_first, prev_label, curr_label, modulo):
    """Check that device sequence is continuous across two consecutive chunk files."""
    if prev_last is None:
        return 0
    diff = (curr_first - prev_last) % modulo
    if diff == 1:
        print(f"  [seq]   ✅ Transition {os.path.basename(prev_label)} → {os.path.basename(curr_label)}: continuous")
        return 0
    else:
        lost = (diff - 1) % modulo
        print(f"  [seq]   ❌ Transition {os.path.basename(prev_label)} → {os.path.basename(curr_label)}: "
              f"gap! {prev_last} → {curr_first}  (diff={diff} mod {modulo}, lost≈{lost})")
        return lost


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Validate ScientISST session frame continuity.')
    parser.add_argument('session_folder', help='Path to session folder containing session.json')
    parser.add_argument('--seq-modulo', type=int, default=None,
                        help='NSeq wrap-around size (default: auto-detect, fallback 16)')
    args = parser.parse_args()

    session_path = os.path.join(args.session_folder, 'session.json')
    if not os.path.exists(session_path):
        print(f"session.json not found in {args.session_folder}")
        sys.exit(1)

    chunks_with_segments = get_session_chunks(session_path)

    # Pre-load all frames to auto-detect modulo if not provided
    all_frames_list = []
    for filepath, _ in chunks_with_segments:
        try:
            all_frames_list.append(load_frames(filepath))
        except Exception as e:
            print(f"⚠️  Could not read {filepath}: {e}")
            all_frames_list.append([])

    modulo = args.seq_modulo
    if modulo is None:
        modulo = detect_modulo(all_frames_list) or 16
        print(f"NSeq modulo: {modulo} ({'auto-detected' if detect_modulo(all_frames_list) else 'default fallback'})\n")
    else:
        print(f"NSeq modulo: {modulo} (user-specified)\n")

    total_bm_lost = 0
    total_dev_lost = 0

    prev_segment = None
    prev_bm_last = None
    prev_dev_last = None
    prev_filepath = None

    for (filepath, segment), frames in zip(chunks_with_segments, all_frames_list):
        label = os.path.basename(filepath)
        print(f"── {label}  (segment {segment}) ──────────────────────")

        if not frames:
            print("  ⚠️  Empty or unreadable file")
            prev_segment = segment
            prev_bm_last = None
            prev_dev_last = None
            prev_filepath = filepath
            continue

        # Internal checks
        bm_gaps, bm_first, bm_last = check_bm_seq_internal(frames, label)
        dev_gaps, dev_first, dev_last = check_device_seq_internal(frames, label, modulo)
        total_bm_lost += bm_gaps
        total_dev_lost += dev_gaps

        # Transition checks (only within the same segment)
        if prev_segment == segment:
            total_bm_lost += check_bm_seq_transition(prev_bm_last, bm_first, prev_filepath, filepath)
            total_dev_lost += check_device_seq_transition(prev_dev_last, dev_first, prev_filepath, filepath, modulo)
        elif prev_segment is not None:
            print(f"  [    ] ── Segment boundary {prev_segment} → {segment}, transitions skipped ──")

        prev_segment = segment
        prev_bm_last = bm_last
        prev_dev_last = dev_last
        prev_filepath = filepath
        print()

    # Summary
    print("═" * 55)
    print("  SUMMARY")
    print("═" * 55)
    if total_bm_lost == 0:
        print("  [__seq]  ✅ No frames lost at IPC/buffer level")
    else:
        print(f"  [__seq]  ❌ ~{total_bm_lost} frame(s) lost at IPC/buffer level")
    if total_dev_lost == 0:
        print("  [seq]    ✅ No frames lost at device/transmission level")
    else:
        print(f"  [seq]    ❌ ~{total_dev_lost} frame(s) lost at device/transmission level")
    print("═" * 55)


if __name__ == '__main__':
    main()
