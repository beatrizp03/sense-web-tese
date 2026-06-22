# End-to-end testing guide for the analysis worker

This file walks you through running the post-hoc analysis pipeline against
synthetic signals, one signal kind at a time. Use it to confirm both the
BioSPPy and NeuroKit2 integrations are working after dependency changes,
worker edits, or environment migrations.

The flow is the same every time:

1. Generate a synthetic session for a given signal kind.
2. Run the analysis worker on that session.
3. Inspect the JSON + CSV outputs.

The synthetic session generator is [`make_synthetic_session.py`](make_synthetic_session.py).
The analyser itself is [`analysis_worker.py`](analysis_worker.py).

---

## 0. Prerequisites

You only need to do this once per machine.

```bash
pip install -r apps/sense-desktop/python/requirements.txt
```

Then sanity-check that every library imports:

```bash
python -c "import biosppy.signals.ecg; import biosppy.signals.eda; import biosppy.signals.ppg; import biosppy.signals.emg; import biosppy.signals.resp; import biosppy.signals.eeg; import biosppy.signals.pcg; import biosppy.signals.acc; import neurokit2; import mne; print('all good')"
```

You should see `all good`. If you get a `ModuleNotFoundError`, install whichever
package it names and try again.

> **Python version note:** stick to Python 3.11 or 3.12 for the smoothest
> experience. Newer interpreters (3.13/3.14) sometimes lack prebuilt wheels
> for `biosppy`, `peakutils`, `opencv-python`, or `mne` and may require source
> builds on Windows.

---

## 1. The universal recipe

For every kind below, you run **two commands** and then inspect the output.

```bash
# 1. Generate a 60-second synthetic session for <kind>
python apps/sense-desktop/python/make_synthetic_session.py <kind>

# 2. Run the analysis worker on it
python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-<kind>" \
  --output-folder  "apps/sense-desktop/data/synthetic-<kind>/output"
```

**Chunking matches real recordings.** The generator splits frames into
`sample1_chunk{0..N-1}.json` files at the same threshold the live
`BufferManager` uses (10,000 frames per chunk by default — 10s at 1 kHz).
A 60-second session produces 6 chunk files; a 2-hour session produces
~720. The worker reads all of them via `manifest.chunks`.

Override the chunk size with `--chunk-size N` if you want fewer/larger files
(e.g. `--chunk-size 60000` to match the legacy single-chunk behavior for a
60s session).

Outputs land in `apps/sense-desktop/data/synthetic-<kind>/output/`:

| File | What it contains |
|---|---|
| `analysis-result.json` | Full per-channel analysis: signalKind, libraries used, raw biosppy/neurokit2 outputs, flat feature dicts, warnings |
| `analysis-summary.csv` | One row per channel: count/mean/std/min/max + which libraries ran |
| `analysis-biosppy-features.csv` | One row per scalar BioSPPy feature (segment, channel, label, signalKind, feature, value) |
| `analysis-neurokit2-features.csv` | One row per scalar NeuroKit2 feature (same shape as the biosppy CSV) |
| `segment-1/channels/AI*.csv` | Per-channel raw time series, exported during analysis |

### The one-liner inspector

After running the worker, this snippet prints what each channel produced.
It shows both **channel-level warnings** (e.g. "no signal-kind mapping") and
**analysis-level warnings** (real processing failures from BioSPPy or
NeuroKit2):

```bash
python -c "
import json
path = 'apps/sense-desktop/data/synthetic-<kind>/output/analysis-result.json'
with open(path) as f:
    r = json.load(f)
for seg in r['segments']:
    for ch in seg['channels']:
        a = ch.get('analysis', {})
        print(f\"{ch['channel']} ({ch['signalKind']}): libs={a.get('libraries')}, \"
              f\"biosppy={len(a.get('biosppyFeatures', {}))}, \"
              f\"nk={len(a.get('neurokit2Features', {}))}, \"
              f\"ch_warns={len(ch.get('warnings', []))}, \"
              f\"an_warns={len(a.get('warnings', []))}\")
"
```

Replace `<kind>` with the actual session folder name.

---

## 2. Two-session sweep — cover all 9 kinds with two imports

If you want to verify every signal kind end-to-end with the smallest number
of sessions possible, generate **`set1`** and **`set2`**. Together they
exercise all 9 supported kinds — and you only need to import two folders
into the desktop app.

| Session | Channel layout |
|---|---|
| **set1** | AI1=ecg, AI2=eda, AI3=ppg, AI4=emg, AI5=rsp |
| **set2** | AI1=eog, AI2=eeg, AI3=pcg, AI4=acc |

```bash
# Generate both sessions
python apps/sense-desktop/python/make_synthetic_session.py set1
python apps/sense-desktop/python/make_synthetic_session.py set2

# Analyse both sessions
python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-set1" \
  --output-folder  "apps/sense-desktop/data/synthetic-set1/output"

python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-set2" \
  --output-folder  "apps/sense-desktop/data/synthetic-set2/output"
```

**Expected outcome for `set1`** (use the one-liner inspector from §1):

| Channel | signalKind | libraries | biosppy | neurokit2 | ch_warns | an_warns |
|---|---|---|---|---|---|---|
| AI1 | ecg | biosppy + neurokit2 | ~30 | 70+ (full HRV) | 0 | 0 |
| AI2 | eda | biosppy + neurokit2 | ~55 | 1 | 0 | 0 |
| AI3 | ppg | biosppy + neurokit2 | ~30 | 1 | 0 | 0 |
| AI4 | emg | biosppy + neurokit2 | ~15 | 1 | 0 | 0 |
| AI5 | rsp | biosppy + neurokit2 | ~25 | 1 | 0 | 0 |
| AI6 | generic | (none) | 0 | 0 | 1 (no mapping) | 0 |

**Expected outcome for `set2`:**

| Channel | signalKind | libraries | biosppy | neurokit2 | ch_warns | an_warns |
|---|---|---|---|---|---|---|
| AI1 | eog | neurokit2 only | 0 | 1 | 0 | 0 |
| AI2 | eeg | biosppy only | ~10 | 0 | 0 | 0 |
| AI3 | pcg | biosppy only | ~32 | 0 | 0 | 0 |
| AI4 | acc | biosppy only | 0 | 0 | 0 | **1** (3-axis caveat) |
| AI5 | generic | (none) | 0 | 0 | 1 (no mapping) | 0 |
| AI6 | generic | (none) | 0 | 0 | 1 (no mapping) | 0 |

If your numbers match (within a few features either side), the entire
analysis pipeline is healthy.

> The `an_warns=1` on `set2` AI4 is **expected** — BioSPPy's accelerometer
> module wants 3-axis input and we feed it 1-D synthetic data. Anything more
> than this one acc warning means a real regression to investigate.
>
> The `ch_warns=1` rows for unmapped channels (AI6 in set1, AI5/AI6 in set2)
> are also expected and benign — they just say "no signal-kind was assigned
> to this channel; exported raw series only".

#### Importing into the desktop app

The two folders are at:

- `apps/sense-desktop/data/synthetic-set1/`
- `apps/sense-desktop/data/synthetic-set2/`

The synthetic generator writes both files in the **exact format** the
Electron app produces during a real recording:

- `session.json` mirrors the schema produced by `SessionManager.createSession`
  (sessionId, startedAt, endedAt, deviceType, sampleRate, channels[],
  channelNames, channelSignalKinds, adcChars, segments[], chunks[], csvHeader).
- `sample1_chunk0.json` is laid out the way `ChunkedDataWriter` writes —
  top-level JSON array of frames, each frame pretty-printed with `indent=2`
  at the array's indent level 0.

So you can:

1. Open the desktop app (`pnpm dev:desktop` from the repo root).
2. Go to the **Analysis** page → **Import Session Folder**.
3. Pick `apps/sense-desktop/data/synthetic-set1/` (or `synthetic-set2/`).
4. The app will load the manifest, show all 6 channels with their pre-set
   signal-kind dropdowns matching the layout above.
5. Click **Run Analysis**. The resulting `analysis-result.json` will land
   inside the same session folder and should match the tables above.

### 2.1 Long-duration sessions (e.g. 2-hour stress test)

The generator can produce arbitrarily long sessions by overriding`--duration`. Memory stays bounded because frames are streamed to disk per
chunk rather than materialized all at once.

```bash
# 2 hours of set1 — will take several minutes to generate and several
# more to analyse. Produces ~720 chunk files, ~1.5 GB total on disk.
python apps/sense-desktop/python/make_synthetic_session.py set1 --duration 7200

python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-set1" \
  --output-folder  "apps/sense-desktop/data/synthetic-set1/output"
```

Per-channel feature counts should match the §2.10 tables — duration
affects neither the BioSPPy nor NeuroKit2 feature schemas, only the values.

**What 2h actually buys you over 5min:**
- Full HRV LF-band coverage (LF needs ≥5 min already, but longer = more
  reliable estimates).
- Confidence the worker doesn't choke on real-scale data: many chunk
  files, large feature dicts, sustained CPU/memory load.

**Expectations:**
- Generation time: ~2–5 minutes wall-clock (NeuroKit2 simulators dominate).
- Worker time: ~5–15 minutes (BioSPPy + NeuroKit2 peak detection scales
  with N; HRV nonlinear features are O(N log N) and the slowest piece).
- Disk: ~1.5–2 GB across ~720 small chunk files (10K frames each).
- Peak RAM during generation: a few GB (signals held as full numpy arrays).
- Peak RAM during analysis: depends on biosppy/neurokit2 internals — on
  most workstations stays under 2 GB.

If RAM becomes a problem on multi-hour sessions, the simulator step is the
bottleneck (it allocates the full signal array per channel). Switching to
streamed simulation is the next optimization to consider.

### 2.2 Legacy `all`-in-one session

A single 6-channel session covering eda/ppg/rsp/ecg/pcg/acc:

```bash
python apps/sense-desktop/python/make_synthetic_session.py all
python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-all" \
  --output-folder  "apps/sense-desktop/data/synthetic-all/output"
```

Kept for backwards compat with earlier docs, but the **`set1` + `set2`**
combination above is preferred because it covers every kind including EMG,
EOG, and EEG.

---

### 2.3 Benchmarking EDA method speed vs agreement

This is the exact terminal flow I used to verify the benchmark script.

#### Step 1: create a small EDA session for a fast smoke test

```powershell
python apps/sense-desktop/python/make_synthetic_session.py eda --duration 5 --name synthetic-benchmark-smoke
```

That writes a disposable session folder at `apps/sense-desktop/data/synthetic-benchmark-smoke/`.

#### Step 2: run the benchmark against that session

```powershell
python apps/sense-desktop/python/benchmark_eda_methods.py --session-folder "apps/sense-desktop/data/synthetic-benchmark-smoke" --report-path "apps/sense-desktop/data/synthetic-benchmark-smoke/eda-benchmark-report.json"
```

That runs the analysis worker twice on the same session:

- once with `SENSE_ANALYSIS_EDA_METHOD=cvxEDA`
- once with `SENSE_ANALYSIS_EDA_METHOD=smoothmedian`

The script prints the runtime for both runs and the overlap metrics to the terminal.

The worker uses `cvxEDA` as the single default. You can override it for
benchmarking with `--eda-method` or by setting `SENSE_ANALYSIS_EDA_METHOD`:

```powershell
python apps/sense-desktop/python/analysis_worker.py \
  --session-folder "apps/sense-desktop/data/synthetic-benchmark-smoke" \
  --output-folder "apps/sense-desktop/data/synthetic-benchmark-smoke/output" \
  --eda-method smoothmedian
```

## 3. Cleaning up

The synthetic sessions live under `apps/sense-desktop/data/synthetic-*/`.
They're harmless to keep but can grow; remove them with:

```bash
rm -rf apps/sense-desktop/data/synthetic-*
```

---

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `BioSPPy module biosppy.signals.<kind> is unavailable` on every channel | BioSPPy's `peakutils` or another transitive dep is missing | `pip install -r apps/sense-desktop/python/requirements.txt`, then `python -c "import biosppy.signals.ecg"` to confirm |
| `NeuroKit2 EOG processing failed: ... 'mne' module is required ...` | `mne` not installed | `pip install mne` |
| `HRV_LF` missing from neurokit2 CSV | Session shorter than ~5 minutes | Re-run with `--duration 300` |
| All channel summaries are zero (real session, not synthetic) | Session was recorded with no signal source / device disconnected | Record a new session with the device actually attached and a signal present |
| `analysis-result.json` not overwritten after re-running | Worker silently failed | Check stderr; the worker writes a JSON error block on failure |
| Worker exits with 1 | Look at stderr — the worker writes a JSON error blob describing what went wrong |

---

## 5. What this guide does *not* test

- The Electron desktop UI flow (record → save → analyse via UI button). This
  guide hits the worker directly. To test the UI path, record a session
  through the app and trigger analysis from there.
- The PyInstaller-frozen worker. To test that, build the worker with
  [`build_worker.py`](build_worker.py) and point `PYTHON_EXECUTABLE` at the
  resulting binary.
- Real biophysical signal validity. Synthetic signals exercise code paths;
  they don't tell you whether feature *values* are clinically meaningful.
