# Post-hoc analysis pipeline

This document describes the current behaviour of [`analysis_worker.py`](analysis_worker.py)
and its BioSPPy wrapper [`signal_processor.py`](signal_processor.py) as implemented in the repository.

## Overall flow

`analysis_worker.py` runs post-hoc on a finalized session folder. High-level steps:

1. Read `session.json` to determine `sampleRate` and `channelSignalKinds` (mapping channel → kind: `ecg, eda, ppg, emg, rsp, eog, eeg, pcg, acc`).
2. Load chunk files and extract, per channel, a 1-D numeric series (raw samples and indices).
3. For each channel the worker selects the signal handler by `signalKind` and runs libraries according to the resolved library policy:
   - BioSPPy via `signal_processor.process_signal` (default primary for `ecg, eda, ppg, emg, rsp, eeg, pcg, acc`).
   - NeuroKit2 via `analyze_<kind>` wrappers (used for `ecg, eda, ppg, emg, rsp, eog` via `nk.<kind>_process`, and `eeg` via `nk.eeg_power`, when enabled; ECG → HRV and PPG → PRV are computed per window from the corrected peaks,  see [Windowed feature extraction](#windowed-feature-extraction)).
4. Handlers call the libraries' high-level routines (e.g. `biosppy.signals.*`, `nk.*_process`) with defaults; the worker extracts structured metadata and scalar summaries. Large arrays are pruned (see `ARRAY_PRESERVE_LIMIT`).
5. Outputs are written to the analysis folder; typical artifacts:

- `analysis-config.json` - resolved run configuration / library policy. Written by the Electron main process (`buildAnalysisRunConfig` in `main.js`) and passed to the worker via `--config`; not written by the worker itself.
- `analysis-log.csv` - event/timing log created by `AnalysisLogger`.
- `analysis.json` - nested per-segment/channel results (per-library blocks, `preprocessing`, `outlierRemoval`); large arrays pruned above `ARRAY_PRESERVE_LIMIT`.
- `features.csv` - long format; columns `segment, channel, label, signalKind, library, feature, value`. The `library` column is `biosppy`, `neurokit2`, or `derived` (windowed EMG features), plus `meta` rows that carry the per-channel `preprocessing` and `outlierRemoval` JSON.
- `summary.csv` - one row per segment/channel with high-level stats and which libraries ran.
- `README.md` - short human-facing summary describing the analysis folder layout.
- `segment-<N>/` directories - per-segment subfolders with per-segment raw CSVs and per-channel exports (ScientISST FileWriter-compatible CSVs). Also hold the windowed-feature CSVs `emg_windows/`, `hrv_windows/`, `prv_windows/` when EMG/ECG/PPG channels are present (see [Windowed feature extraction](#windowed-feature-extraction)).

## BioSPPy path - `signal_processor.process_signal(kind, values, sample_rate)`


| Kind | Function called | What it returns / what is stored |
|---|---|---|
| ECG | `biosppy.signals.ecg.ecg` | `ts`, `filtered` (FIR band-pass ≈3–45 Hz), `rpeaks` (Hamilton segmenter), `templates`/`templates_ts` (extracted beats), `heart_rate`/`heart_rate_ts` (instantaneous HR from RR) |
| EDA | `biosppy.signals.eda.eda` | `ts`, `filtered`, `onsets`, `peaks`, `amplitudes` (SCR events + amplitudes) |
| PPG | `biosppy.signals.ppg.ppg` | `ts`, `filtered`, `onsets` (systolic onsets), `heart_rate`/`heart_rate_ts` |
| EMG | `biosppy.signals.emg.emg` | `ts`, `filtered`, `onsets` (activation onsets via threshold detector) |
| RSP | `biosppy.signals.resp.resp` | `ts`, `filtered` (band-pass ≈0.1–0.35 Hz), `zeros` (zero-crossings), `resp_rate`/`resp_rate_ts` |
| EEG | `biosppy.signals.eeg.eeg` | `ts`, `filtered`, per-band power over time (`theta, alpha_low, alpha_high, beta, gamma`), `plf_pairs`/`plf` (phase-locking factor between channel pairs) |
| PCG | `biosppy.signals.pcg.pcg` | `ts`, `filtered`, `peaks`, heart-sound classification (S1/S2), `heart_rate` |
| ACC | `biosppy.signals.acc.acc` | `ts`, per-axis processed signal, vector magnitude (version-dependent) |

## NeuroKit2 path - `analyze_<kind>` in `analysis_worker.py`

Most `analyze_<kind>` wrappers call `nk.<kind>_process(signal, sampling_rate=…)` →
`(signals_df, info)` (EEG is the exception,  it calls `nk.eeg_power` on an MNE
`RawArray`). The full `signals_df` is **not** stored (sample-length); only its
**column names** and the `info` dict (arrays >10 k samples are pruned) are kept.
For ECG/PPG the windowed HRV/PRV metrics are stored as per-window CSVs plus
cross-window aggregates in `neurokit2.derivedFeatures` (see
[Windowed feature extraction](#windowed-feature-extraction)), not as a single
whole-session HRV table.

| Kind | Function(s) called | Key `signals_df` columns / `info` contents |
|---|---|---|
| ECG | `nk.ecg_process` → then `nk.hrv(peaks, sampling_rate)` **per window** | `ECG_Clean` (default "neurokit": ~0.5 Hz high-pass Butterworth + powerline notch), `ECG_R_Peaks`, `ECG_Rate`, `ECG_Quality`, delineated waves `ECG_P/Q/S/T_Peaks` + on/offsets, `ECG_Phase_*`. **`nk.hrv`** is run per 5-min window (see [Windowed feature extraction](#windowed-feature-extraction)) yielding time-domain (`HRV_RMSSD, HRV_SDNN, HRV_pNN50, …`), frequency-domain (`HRV_LF, HRV_HF, HRV_LFHF, …`), and nonlinear (`HRV_SD1, HRV_SD2, HRV_SampEn, HRV_DFA_*, …`) metrics |
| EDA | `nk.eda_process(signal, sampling_rate)` (library defaults; **no** `method=` argument passed) | `EDA_Clean`, `EDA_Tonic` (SCL), `EDA_Phasic` (SCR driver), `SCR_Onsets, SCR_Peaks, SCR_Height, SCR_Amplitude, SCR_RiseTime, SCR_RecoveryTime`. The `--eda-method` flag (alias of `libraryPreference`, or `SENSE_ANALYSIS_EDA_METHOD`) selects **which library runs** (`neurokit`, `biosppy`, or `auto`/both); it is *not* forwarded as the NeuroKit2 decomposition method. cvxEDA / custom `eda_phasic` is future work, not wired. |
| PPG | `nk.ppg_process` → then `nk.hrv(PPG_Peaks)` **per window** | `PPG_Clean`, `PPG_Rate`, `PPG_Peaks`, `PPG_Quality`. Pulse-rate variability is computed per window from `PPG_Peaks` and relabelled `PRV_*` (see [Windowed feature extraction](#windowed-feature-extraction)). |
| EMG | `nk.emg_process` (+ windowed Hudgins/spectral features) | `EMG_Clean` (high-pass + rectify), `EMG_Amplitude` (envelope), `EMG_Activity`, `EMG_Onsets`, `EMG_Offsets`. The Hudgins time-domain set + `MNF`/`MDF` are additionally computed per sliding window (see [Windowed feature extraction](#windowed-feature-extraction)). |
| RSP | `nk.rsp_process` | `RSP_Clean`, `RSP_Amplitude`, `RSP_Rate` (breathing rate), `RSP_Phase` / `RSP_PhaseCompletion`, `RSP_Peaks`, `RSP_Troughs`, `RSP_RVT`, symmetry metrics |
| EOG | `nk.eog_process` → then `_extract_eog_features` | `EOG_Clean`, `EOG_Blinks`, `EOG_Rate`; `info` has blink/onset indices. The custom extractor adds `EOG_Blinks_count`, `EOG_Blink_Rate_per_min`, `EOG_IBI_Mean_s` / `EOG_IBI_SD_s` (inter-blink intervals from `diff(sorted blinks)/fs`), `EOG_Rate_Mean/SD/Min/Max` |
| EEG | `nk.eeg_power` (on an MNE `RawArray`; **not** `nk.eeg_process`) | Per-channel band power `EEG_Power_Delta/Theta/Alpha/Beta/Gamma`. The signal is wrapped in `mne.io.RawArray`; requires the `mne` dependency. Stored under `neurokit2` as `{method, bands, channelCount, info}`. |
| anything else | `analyze_generic` | neither library; raw `count/mean/std/min/max` only |

## Windowed feature extraction

On top of the libraries' full-length outputs, two feature sets are computed over **sliding/segmented windows** so the results follow standard domain conventions. Both window lengths/steps are user-configurable (UI → `analysis-config.json` → worker globals) and degrade gracefully when a recording is too short.

| Signal | What is windowed | Default window / step | Library basis | Output |
|---|----------------------|--|--|--|
| **EMG** | Hudgins time-domain set (`EMG_MAV, EMG_RMS, EMG_WL, EMG_ZC, EMG_SSC`) + spectral fatigue indices (`EMG_MNF, EMG_MDF` via a Welch PSD) | `emgWindowMs` 200 ms / `emgWindowStepMs` 100 ms (50% overlap) | Custom NumPy/SciPy on the cleaned signal (`EMG_Clean` if NeuroKit2 ran, else finite-sanitized), neither library emits these directly | per-window series in `segment-<N>/emg_windows/<channel>.csv`; cross-window `*_mean/_std/_min/_max` + `EMG_window_count` in `features.csv` under the **`derived`** library |
| **ECG** | Heart-rate variability — `nk.hrv()` run per window over the (corrected) R-peaks falling inside it | `hrvWindowSec` 300 s / `hrvWindowStepSec` 300 s (consecutive, non-overlapping) | NeuroKit2 `nk.hrv` (Task Force ESC/NASPE 1996 5-min short-term standard) | per-window `HRV_*` metrics in `segment-<N>/hrv_windows/<channel>.csv`; cross-window aggregates + `HRV_window_count` in `features.csv` under **`neurokit2`** |
| **PPG** | Pulse-rate variability — same `nk.hrv()` engine on the detected `PPG_Peaks`; metrics relabelled `HRV_*` → `PRV_*` | `hrvWindowSec` 300 s / `hrvWindowStepSec` 300 s | NeuroKit2 `nk.hrv` | per-window `PRV_*` metrics in `segment-<N>/prv_windows/<channel>.csv`; cross-window aggregates + `PRV_window_count` in `features.csv` under **`neurokit2`** |

Helpers: `compute_emg_windowed_features`, `compute_hrv_windowed` (shared by ECG/PPG), `export_emg_windows_csv`, `export_hrv_windows_csv`. Per-window series are stashed on transient `_emgWindows`/`_hrvWindows` fields, exported to CSV by `write_channel_series_csvs`, then dropped so they don't bloat `analysis.json`. A recording shorter than one window collapses to a single whole-signal window (preserving the previous whole-session HRV behaviour).

### Conventions deliberately *not* implemented

Windowing conventions that are **not** functions in BioSPPy or NeuroKit2 were intentionally left out (they would require bespoke algorithms, not library calls):

- **ACC** sliding-window activity recognition (1–10 s windows; Bouten 1997 / Bao & Intille 2004) and impact-event detection,  `biosppy.signals.acc.acc` does basic per-axis processing only.
- **EEG** 30-s sleep epochs (AASM) and stimulus-locked ERP epoching,  no event markers in the data; not provided by the libraries.
- **EOG** saccade detection,  NeuroKit2 detects blinks only.

EDA (event-based SCR + session aggregate), RSP (per-breath), and PCG (per-cardiac-cycle) already match their conventions with the stock library calls.

## How features get out

- **BioSPPy** - `_extract_features` keeps scalar fields as-is and turns numeric
  arrays (`rpeaks`, `heart_rate`, …) into `<name>_count/_mean/_std/_min/_max`. →
  `biosppyFeatures`.
- **NeuroKit2** - `extract_neurokit2_features` flattens every finite scalar in
  `info`, summarizes numeric arrays in `info` the same way, includes any `hrv`
  rows if present (legacy; the current code path stores HRV windowed instead),
  and includes `derivedFeatures`. `derivedFeatures` now carries the windowed
  HRV/PRV aggregates (ECG/PPG) and the EOG blink-derived features. →
  `neurokit2Features`.
- **Outlier removal** - library-provided peak correction runs where available, replaces the affected peak arrays, and refreshes the derived peak stats. Results are recorded under each library block's `outlierRemoval` and aggregated onto the channel as `record['outlierRemoval']`. See [Outlier Removal (details)](#outlier-removal-details) below.

## Mapping to the "four operations" table (Load · Filter · FE · OR)

| Operation | Status | Where |
|---|---|---|
| **Load** | Done (custom JSON-chunk loader feeds both libraries) | `load_chunk_frames`, `channel_series`, `discover_chunk_entries` |
| **Filter** | Done, but **implicit** - happens inside `biosppy.signals.<kind>.<kind>(...)` and inside `nk.<kind>_process` (`<kind>_clean`); no filter parameters are exposed (the `--eda-method` flag only selects which library runs, not a filter setting). The NeuroKit2 cleaned `signals_df` is dropped (only column names kept); BioSPPy's `filtered` array is kept in `analysis.json` but pruned above `ARRAY_PRESERVE_LIMIT`. | per-signal handlers; `--eda-method` |
| **FE (Feature Extraction)** | Done for both libraries, all signal kinds they support | `_extract_features`, `extract_neurokit2_features`, `nk.hrv`, `_extract_eog_features` |
| **OR (Outlier Removal)** | **Implemented (library-provided peak correction)** - runs BioSPPy & NeuroKit2 peak-correction when peak metadata is present; conditional and disable-able via CLI/env. | `_apply_biosppy_outlier_removal`, `_apply_neurokit2_outlier_removal`, `analyze_<kind>` wrappers; BioSPPy callsites in `signal_processor.py`; feature extraction in `extract_neurokit2_features`, `_extract_features` |

### Outlier Removal (details)

- BioSPPy: `biosppy.signals.ecg.correct_rpeaks(signal, rpeaks, sampling_rate)` is invoked for ECG results (when present); corrected peak arrays replace `biosppy.output.rpeaks` and supporting derived stats are refreshed in `biosppyFeatures`.
- NeuroKit2: `neurokit2.signal_fixpeaks` is invoked for supported peak arrays found in `neurokit2.info` (ECG_R_Peaks, PPG_Peaks, SCR_Peaks/SCR_Onsets, RSP_Peaks, EOG_Blinks/Blinks). Corrected peaks replace the original arrays in `neurokit2.info` and `neurokit2.outlierRemoval` records details.
- When corrected peaks are present and sufficient (≥4 per window), HRV (ECG) and PRV (PPG) are computed from the corrected peaks via `nk.hrv` over configurable windows; per-window CSVs plus cross-window aggregates in `neurokit2.derivedFeatures` (see [Windowed feature extraction](#windowed-feature-extraction)).
- Outlier removal is conditional: it requires peak metadata and at least 3 peaks; failures are captured in the library block (`reason`) and do not abort analysis.
- Outlier removal can be disabled globally using `--disable-outlier-removal` (CLI) or the environment variable `SENSE_ANALYSIS_DISABLE_OUTLIER_REMOVAL`.

## Known limitations & future work

1. **High-level convenience functions, library defaults** - the worker relies on the libraries' high-level convenience routines (`biosppy.signals.*`, `nk.*_process`) and uses their defaults; it does not replace the library's internal `clean → peaks → delineate` pipelines with bespoke parameters.
2. **HRV/PRV depend on window length and peak count** - each window needs ≥4 corrected peaks or it is skipped, and several frequency-domain and nonlinear metrics require longer windows than the 5-min default to be meaningful (otherwise NeuroKit2 returns them as NaN). Choose the window length to suit the recording.
3. **Outlier/artifact handling is limited** - in-tree outlier handling is limited to library-provided peak-correction helpers; there is no global quality-index gating, no automated NaN/clipping repair, no multi-step artifact-rejection pipeline beyond `signal_fixpeaks`/`correct_rpeaks` and basic finite-value sanitization.
4. **EEG and ACC multi-channel semantics** - the worker attempts to group EEG/ACC channels into multi-channel matrices and runs multi-channel analysis (`analyze_eeg`, `analyze_acc`) when channels can be aligned; however, when alignment fails or channels are analyzed individually the worker supplies a single 1‑D series per channel. Behaviour (band-power, PLF, vector magnitude, axis ordering) therefore depends on whether grouping succeeded and on the underlying library implementation.
5. **Clean/filtered signals are not persisted by default** - cleaned/filtered arrays produced by the libraries are included in `analysis.json` but pruned when arrays exceed the `ARRAY_PRESERVE_LIMIT` (10k samples); channel CSVs contain raw recorded samples.

