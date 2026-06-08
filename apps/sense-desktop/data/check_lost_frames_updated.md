# `check_lost_frames_updated.py`

**What it does.** Checks a finished recording for dropped frames. It reads the
session's data files and verifies that the two per-frame counters increase by
exactly 1 from one frame to the next; a larger jump means frames were lost, and
the script reports how many and where.

**How to run it.**

```
python check_lost_frames_updated.py <session_folder> [--seq-modulo N]
```

`<session_folder>` must contain `session.json`. `--seq-modulo` is optional - the
device counter's wrap size; it's auto-detected, default 16.

## The idea, in four points

1. A recording is a stream of **frames** (one per timepoint).
2. Each frame carries **two counters that should go up by 1 every frame**:
   - `__seq` - written by the **recording software** as it saves each frame.
     Always increasing; it restarts only when the recording is paused and resumed
     (a new **segment**).
   - `sequence` - written by the **device**. Only 4 bits, so it cycles
     `0..15, 0..15, ...`
3. **Step of 1 = healthy. A step of `d` (> 1) means `d - 1` frames were lost.**
   That single rule is the whole test. Running it on `__seq` tells you whether
   frames were lost *inside the computer*; running it on `sequence` tells you
   whether the *device or the wireless link* dropped them.
4. A recording spans several files ("chunks"). The script checks continuity
   *inside each file* and *across the join between consecutive files of the same
   segment* - never across a segment boundary, where the counters legitimately
   restart.

## What each function does

| Function | In one line |
|---|---|
| `load_frames(path)` | Read one data file (JSON array, `{"frames": [...]}`, or NDJSON) into a list of frame records. |
| `get_session_chunks(path)` | Read `session.json`; return `[(file, segment), ...]` in recording order. |
| `step(a, b, modulo=None)` | The difference `b - a`, taken `% modulo` when the counter wraps. **This is the core of the test.** |
| `_tag(tag)` | Cosmetic: pad `[__seq]` / `[seq]` to a fixed width so the report lines align. |
| `_print_gaps(gaps, ...)` | Print one counter's result: a ✅ "no gaps" line, or a ❌ line plus the first 5 gaps (where, value before → after, jump size, frames lost). |
| `check_internal(frames, label, field, tag, modulo=None)` | Run the step-of-1 test on one counter (`field`) inside one file. Returns `(frames_lost, first_value, last_value)`. |
| `check_transition(prev_last, curr_first, ...)` | Run the same test on the join between two files: does the next file start one count after the previous one ended? Returns frames lost at the seam. |
| `detect_modulo(frames_list)` | Find the device counter's wrap size automatically (the value just before the first roll-over, + 1). `None` if it never wraps. |
| `main()` | Parse arguments, load all the files, pick the wrap size, loop over the files running the two within-file checks and the seam checks, add up the totals, print the summary. |

## The logic functions that were implemented

Everything else is reading files and printing. The substance is here:

```python
def step(a, b, modulo=None):
    return (b - a) % modulo if modulo else b - a
```

The difference between consecutive counter values. For `__seq` it's plain
`b - a`. For `sequence` the `% 16` makes the `15 → 0` roll-over read as a step of
`1`, not `-15`. It's also used as `step(1, d)` = `d - 1` = "frames missing in a
jump of size `d`."

```python
def check_internal(frames, label, field, tag, modulo=None):
    seqs = [f[field] for f in frames if field in f]          # the counter, frame by frame
    ...
    gaps = [(i, a, b, d)
            for i, (a, b) in enumerate(zip(seqs, seqs[1:]))  # every consecutive pair
            if (d := step(a, b, modulo)) != 1]               # keep the ones that aren't a step of 1
    ...
    lost = sum(step(1, d, modulo) for *_, d in gaps)         # total frames missing
    return lost, seqs[0], seqs[-1]
```

Pull the counter out of every frame, look at each consecutive pair, flag any pair
whose step isn't 1, add up the implied losses. It also returns the first and last
value so the caller can check whether the *next* file continues where this one
stopped. If a file's frames don't carry that counter at all, it prints a ⚠️
warning and reports zero loss instead of crashing.

```python
def check_transition(prev_last, curr_first, ...):
    if prev_last is None: return 0           # there is no previous file yet
    d = step(prev_last, curr_first, modulo)
    if d == 1: ...; return 0                 # the two files join cleanly
    ...; return step(1, d, modulo)           # frames lost in the seam
```

The same step-of-1 test, applied once to the boundary between two files.

`main()` just orchestrates these: for each file it calls `check_internal` on
`__seq`, `check_internal` on `sequence`, and - if the file is in the same segment
as the previous one - `check_transition` on each. It sums the four numbers into
two running totals ("lost inside the computer" and "lost at the device") and
prints them at the end.

## What a run looks like

```
NSeq modulo: 16 (auto-detected)

── sample0_chunk0.json  (segment 1) ──────────────────────
  [__seq] ✅ No gaps inside sample0_chunk0.json
  [seq]   ✅ No gaps inside sample0_chunk0.json (modulo=16)

── sample0_chunk1.json  (segment 1) ──────────────────────
  [__seq] ❌ 1 gap(s) inside sample0_chunk1.json:
          frame 412: 4096 → 4099  (diff=3, lost=2)
  [seq]   ✅ No gaps inside sample0_chunk1.json (modulo=16)
  [__seq] ✅ Transition sample0_chunk0.json → sample0_chunk1.json: continuous
  [seq]   ✅ Transition sample0_chunk0.json → sample0_chunk1.json: continuous

═══════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════
  [__seq]  ❌ ~2 frame(s) lost at IPC/buffer level
  [seq]    ✅ No frames lost at device/transmission level
═══════════════════════════════════════════════════════
```

Reading that example: 2 frames went missing *inside the computer* (the `__seq`
side), in `sample0_chunk1.json` around frame 412; the *device* side (`sequence`)
dropped nothing. ("IPC/buffer level" = lost between receiving the data and writing
it to disk; "device/transmission level" = lost by the device or over the link.)
