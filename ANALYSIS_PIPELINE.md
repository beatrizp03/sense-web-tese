# Post-hoc analysis pipeline — current implementation (2026-06-08)

This document describes the current behaviour of [`analysis_worker.py`](analysis_worker.py)
and its BioSPPy wrapper [`signal_processor.py`](signal_processor.py) as implemented in the repository.

## Overall flow

`analysis_worker.py` runs post-hoc on a finalized session folder. High-level steps:

1. Read `session.json` to determine `sampleRate` and `channelSignalKinds` (mapping channel → kind: `ecg, eda, ppg, emg, rsp, eog, eeg, pcg, acc`).
2. Load chunk files and extract, per channel, a 1-D numeric series (raw samples and indices).
3. For each channel the worker selects the signal handler by `signalKind` and runs libraries according to the resolved library policy:
   - BioSPPy via `signal_processor.process_signal` (default primary for `ecg, eda, ppg, emg, rsp, eeg, pcg, acc`).
   - NeuroKit2 via `analyze_<kind>` wrappers (used for `ecg, eda, ppg, emg, rsp, eog` when enabled; ECG → HRV is computed when corrected peaks are available).
4. Handlers call the libraries' high-level routines (e.g. `biosppy.signals.*`, `nk.*_process`) with defaults; the worker extracts structured metadata and scalar summaries. Large arrays are pruned (see `ARRAY_PRESERVE_LIMIT`).
5. PCG is processed full-length like other signals.
6. Outputs are written to the analysis folder; typical artifacts:

- `analysis-config.json` — resolved run configuration / library policy.
- `analysis-log.csv` — event/timing log created by `AnalysisLogger`.
- `analysis.json` — nested per-segment/channel results (per-library blocks, `preprocessing`, `outlierRemoval`); large arrays pruned above `ARRAY_PRESERVE_LIMIT`.
- `features.csv` — long format (`library, feature, value`).
- `summary.csv` — one row per segment/channel with high-level stats and which libraries ran.
- `README.md` — short human-facing summary describing the analysis folder layout.
- `segment-<N>/` directories — per-segment subfolders with per-segment raw CSVs and per-channel exports (ScientISST FileWriter-compatible CSVs).

## BioSPPy path - `signal_processor.process_signal(kind, values, sample_rate)`

Calls `biosppy.signals.<module>.<fn>(signal=…, sampling_rate=…, show=False)`,
converts the returned `ReturnTuple` to JSON, and reduces numeric arrays in the
result to `count/mean/std/min/max` summaries so they reach `features.csv`.

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

Each `analyze_<kind>` calls `nk.<kind>_process(signal, sampling_rate=…)` →
`(signals_df, info)`. The full `signals_df` is **not** stored (sample-length);
only its **column names**, the `info` dict (arrays >10 k samples are pruned), and
, for ECG , the HRV table are kept.

| Kind | Function(s) called | Key `signals_df` columns / `info` contents |
|---|---|---|
| ECG | `nk.ecg_process` → then `nk.hrv(info, sampling_rate)` | `ECG_Clean` (default "neurokit": ~0.5 Hz high-pass Butterworth + powerline notch), `ECG_R_Peaks`, `ECG_Rate`, `ECG_Quality`, delineated waves `ECG_P/Q/S/T_Peaks` + on/offsets, `ECG_Phase_*`. **`nk.hrv`** then yields one row of time-domain (`HRV_RMSSD, HRV_SDNN, HRV_pNN50, …`), frequency-domain (`HRV_LF, HRV_HF, HRV_LFHF, …`), and nonlinear (`HRV_SD1, HRV_SD2, HRV_SampEn, HRV_DFA_*, …`) metrics |
| EDA | `nk.eda_process(signal, sampling_rate, method=eda_method)` | `EDA_Clean`, `EDA_Tonic` (SCL), `EDA_Phasic` (SCR driver), `SCR_Onsets, SCR_Peaks, SCR_Height, SCR_Amplitude, SCR_RiseTime, SCR_RecoveryTime`. `eda_method` defaults to `"neurokit"`, switchable to `"biosppy"` via `--eda-method` (or `SENSE_ANALYSIS_EDA_METHOD`); falls back gracefully if the installed version rejects the value. cvxEDA / `eda_phasic` is noted as future work, not wired. |
| PPG | `nk.ppg_process` | `PPG_Clean`, `PPG_Rate`, `PPG_Peaks`, `PPG_Quality`. **No `nk.hrv` from PPG** currently , only ECG gets HRV. |
| EMG | `nk.emg_process` | `EMG_Clean` (high-pass + rectify), `EMG_Amplitude` (envelope), `EMG_Activity`, `EMG_Onsets`, `EMG_Offsets` |
| RSP | `nk.rsp_process` | `RSP_Clean`, `RSP_Amplitude`, `RSP_Rate` (breathing rate), `RSP_Phase` / `RSP_PhaseCompletion`, `RSP_Peaks`, `RSP_Troughs`, `RSP_RVT`, symmetry metrics |
| EOG | `nk.eog_process` → then `_extract_eog_features` | `EOG_Clean`, `EOG_Blinks`, `EOG_Rate`; `info` has blink/onset indices. The custom extractor adds `EOG_Blinks_count`, `EOG_Blink_Rate_per_min`, `EOG_IBI_Mean_s` / `EOG_IBI_SD_s` (inter-blink intervals from `diff(sorted blinks)/fs`), `EOG_Rate_Mean/SD/Min/Max` |
| anything else | `analyze_generic` | neither library , raw `count/mean/std/min/max` only |

## How features get out

- **BioSPPy** - `_extract_features` keeps scalar fields as-is and turns numeric
  arrays (`rpeaks`, `heart_rate`, …) into `<name>_count/_mean/_std/_min/_max`. →
  `biosppyFeatures`.
- **NeuroKit2** - `extract_neurokit2_features` flattens every finite scalar in
  `info`, summarizes numeric arrays in `info` the same way, flattens the whole
  `hrv` row, and lets the EOG `derivedFeatures` override. → `neurokit2Features`.
- **Outlier removal / feature impact** - the worker applies library-provided peak-correction where available and records the results:

- BioSPPy: `biosppy.signals.ecg.correct_rpeaks` is invoked for ECG results (when present); corrected peak arrays replace `biosppy.output.rpeaks` and supporting derived stats are refreshed in `biosppyFeatures`.
- NeuroKit2: `neurokit2.signal_fixpeaks` is invoked for supported peak arrays found in `neurokit2.info` (ECG_R_Peaks, PPG_Peaks, SCR_Peaks/SCR_Onsets, RSP_Peaks, EOG_Blinks/Blinks). Corrected peaks replace the original arrays in `neurokit2.info` and `neurokit2.outlierRemoval` records details.
- When corrected peaks are present and sufficient (≥3), HRV (`nk.hrv`) is computed from the corrected peaks (ECG only) and stored in `neurokit2.hrv`.
- The outlier-removal results are written into the per-library block under `outlierRemoval` and aggregated onto the channel record as `record['outlierRemoval']` when present.

## Mapping to the "four operations" table (Load · Filter · FE · OR)

| Operation | Status | Where |
|---|---|---|
| **Load** | Done (custom JSON-chunk loader feeds both libraries) | `load_chunk_frames`, `channel_series`, `discover_chunk_entries` |
| **Filter** | Done, but **implicit** - happens inside `biosppy.signals.<kind>.<kind>(...)` and inside `nk.<kind>_process` (`<kind>_clean`); only EDA's method is exposed. Cleaned signals are computed but not persisted. | per-signal handlers; `--eda-method` |
| **FE (Feature Extraction)** | Done for both libraries, all signal kinds they support | `_extract_features`, `extract_neurokit2_features`, `nk.hrv`, `_extract_eog_features` |
| **OR (Outlier Removal)** | **Implemented (library-provided peak correction)** — runs BioSPPy & NeuroKit2 peak-correction when peak metadata is present; conditional and disable-able via CLI/env. | [apps/sense-desktop/python/analysis_worker.py](apps/sense-desktop/python/analysis_worker.py) — `_apply_biosppy_outlier_removal`, `_apply_neurokit2_outlier_removal`, `analyze_<kind>` wrappers; [apps/sense-desktop/python/signal_processor.py](apps/sense-desktop/python/signal_processor.py) — BioSPPy callsites; feature extraction: `extract_neurokit2_features`, `_extract_features` |

### Outlier Removal (details)

- BioSPPy: `biosppy.signals.ecg.correct_rpeaks(signal, rpeaks, sampling_rate)` is invoked for ECG results (when present); corrected peak arrays replace `biosppy.output.rpeaks` and supporting derived stats are refreshed in `biosppyFeatures`.
- NeuroKit2: `neurokit2.signal_fixpeaks` is invoked for supported peak arrays found in `neurokit2.info` (ECG_R_Peaks, PPG_Peaks, SCR_Peaks/SCR_Onsets, RSP_Peaks, EOG_Blinks/Blinks). Corrected peaks replace the original arrays in `neurokit2.info` and `neurokit2.outlierRemoval` records details.
- When corrected peaks are present and sufficient (≥3), HRV (`nk.hrv`) is computed from the corrected peaks (ECG only) and stored in `neurokit2.hrv`.
- Outlier removal is conditional: it requires peak metadata and at least 3 peaks; failures are captured in the library block (`reason`) and do not abort analysis.
- Outlier removal can be disabled globally using `--disable-outlier-removal` (CLI) or the environment variable `SENSE_ANALYSIS_DISABLE_OUTLIER_REMOVAL`.

## Known limitations TODO - Future Work

1. **High-level convenience functions, library defaults** — the worker relies on the libraries' high-level convenience routines (`biosppy.signals.*`, `nk.*_process`) and uses their defaults; it does not replace the library's internal `clean → peaks → delineate` pipelines with bespoke parameters.
2. **HRV is ECG-only** — HRV is computed only from ECG and only when corrected peaks are present and sufficient; PPG peaks are not used as input to `nk.hrv` in the current code path.
3. **Outlier/artifact handling is limited** — in-tree outlier handling is limited to library-provided peak-correction helpers; there is no global quality-index gating, no automated NaN/clipping repair, no multi-step artifact-rejection pipeline beyond `signal_fixpeaks`/`correct_rpeaks` and basic finite-value sanitization.
4. **EEG and ACC multi-channel semantics** — the worker attempts to group EEG/ACC channels into multi-channel matrices and runs multi-channel analysis (`analyze_eeg`, `analyze_acc`) when channels can be aligned; however, when alignment fails or channels are analyzed individually the worker supplies a single 1‑D series per channel. Behaviour (band-power, PLF, vector magnitude, axis ordering) therefore depends on whether grouping succeeded and on the underlying library implementation.
5. **Clean/filtered signals are not persisted by default** — cleaned/filtered arrays produced by the libraries are included in `analysis.json` but pruned when arrays exceed the `ARRAY_PRESERVE_LIMIT` (10k samples); channel CSVs contain raw recorded samples.

