import os
import json
import sys
import re

def get_session_chunks_with_segments(session_path):
    with open(session_path, 'r') as f:
        session = json.load(f)
    # Get chunk file paths and their segment numbers in order
    chunks = [(chunk['file'], chunk.get('segment', 1)) for chunk in session['chunks']]
    if len(chunks) == 0:
        print("No chunks found in session.json")
        sys.exit(1)
    return chunks

def get_seq_key(frame):
    return next((k for k in frame.keys() if 'seq' in k.lower() or 'index' in k.lower()), None)

def get_all_seqs(frames):
    # Return a list of (index, __seq) for all frames that have __seq
    return [(i, f["__seq"]) for i, f in enumerate(frames) if "__seq" in f]

def check_internal_chunk_loss(frames, file):
    seqs = [f["__seq"] for f in frames if "__seq" in f]
    lost = []
    for i in range(len(seqs) - 1):
        diff = seqs[i+1] - seqs[i]
        if diff != 1:
            lost.append((i, seqs[i], seqs[i+1], diff))
    if not lost:
        print(f"[ {os.path.basename(file)} ] ✅ No lost frames inside {os.path.basename(file)}.")
    else:
        print(f"[ {os.path.basename(file)} ] ❌ Lost frames inside {os.path.basename(file)}! {len(lost)} gaps found:")
        for idx, prev, curr, diff in lost[:10]:  # print up to 10
            print(f"    At index {idx}: {prev} -> {curr} (diff={diff})")
        if len(lost) > 10:
            print(f"    ...and {len(lost)-10} more.")
    return len(lost)

def check_chunk_transitions(chunk_files_with_segments):
    prev_last_seq = None
    prev_last_file = None
    prev_last_idx = None
    prev_segment = None
    total_lost = 0
    for i, (file, segment) in enumerate(chunk_files_with_segments):
        with open(file, 'r') as f:
            frames = json.load(f)
        if not frames:
            print(f"{os.path.basename(file)}: No frames found.")
            continue
        # Check for loss inside the file itself
        lost_in_file = check_internal_chunk_loss(frames, file)
        total_lost += lost_in_file
        # Get all __seqs with their indices
        seqs_with_idx = get_all_seqs(frames)
        if not seqs_with_idx:
            continue
        first_idx, first_seq = seqs_with_idx[0]
        last_idx, last_seq = seqs_with_idx[-1]
        if prev_last_seq is not None and prev_segment == segment:
            diff = first_seq - prev_last_seq
            print(f"\nCompare {os.path.basename(prev_last_file)} vs {os.path.basename(file)}:")
            print(f"  Last seq of previous: {prev_last_seq}")
            print(f"  First seq of current: {first_seq}")
            print(f"  Diff: {diff}")
            if diff == 1:
                print("  ✅ No lost frames between these chunks.\n")
            else:
                print(f"  ❌ Lost frames detected! Lost {abs(diff) - 1} frames between these chunks.")
                total_lost += abs(diff) - 1
        elif prev_last_seq is not None and prev_segment != segment:
            print(f"\n--- Segment changed from {prev_segment} to {segment}, skipping comparison ---\n")
        prev_last_seq = last_seq
        prev_last_file = file
        prev_last_idx = last_idx
        prev_segment = segment
    return total_lost

def main():
    if len(sys.argv) < 2:
        print("Usage: python check_lost_frames.py <session_folder>")
        sys.exit(1)
    session_folder = sys.argv[1]
    session_path = os.path.join(session_folder, 'session.json')
    if not os.path.exists(session_path):
        print(f"session.json not found in {session_folder}")
        sys.exit(1)
    chunk_files_with_segments = get_session_chunks_with_segments(session_path)
    total_lost = check_chunk_transitions(chunk_files_with_segments)
    print("\n------------------RESUME SUMMARY------------------")
    if total_lost == 0:
        print("  ✅ No lost frames detected in the session.")
    else:
        print(f"  ❌ Lost frames detected in the session! Total lost: {total_lost}")

if __name__ == '__main__':
    main()
