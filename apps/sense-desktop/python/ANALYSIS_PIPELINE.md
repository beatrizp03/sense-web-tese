# Post-hoc analysis pipeline - 11.05 status

This describes the current behaviour of [`analysis_worker.py`](analysis_worker.py)
and its BioSPPy wrapper [`signal_processor.py`](signal_processor.py). 

## Overall flow

`analysis_worker.py` runs post-hoc on a recorded session:

1. Reads `session.json` → `sampleRate` and `channelSignalKinds` (a map from each
   recorded channel to a signal type: `ecg, eda, ppg, emg, rsp, eog, eeg, pcg,
   acc`).
2. Loads the session's data chunks and, for each channel, extracts a 1-D numeric
   series.
3. The `signalKind` selects a handler. Two libraries are run **independently on
   the same series**:
   - **BioSPPy** via `signal_processor.process_signal` - for `ecg, eda, ppg,
     emg, rsp, eeg, pcg, acc`.
   - **NeuroKit2** via per-signal `analyze_<kind>` functions - for `ecg, eda,
     ppg, emg, rsp, eog` (plus HRV for ECG).
4. In both cases the code calls each library's **high-level "all-in-one"
   routine** with its defaults - it does not hand-compose the
   `clean → peaks → delineate` building blocks.
5. **PCG only** is processed in 60 s non-overlapping windows (then aggregated),
   purely because `biosppy`'s `get_avg_heart_rate()` has O(n²) correlation cost.
   This is a performance workaround, not a methodological choice.
6. Outputs: `analysis.json`, `summary.csv`, `features.csv`, and per-channel
   `channels/CHANNEL_KIND.csv` time series.

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
| PCG | `biosppy.signals.pcg.pcg` | `ts`, `filtered`, `peaks`, heart-sound classification (S1/S2), `heart_rate` - run **per 60 s window** |
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
| EEG / PCG / ACC | - | **NeuroKit2 is not called** (no full pipeline equivalent in NK); these go through BioSPPy only |
| anything else | `analyze_generic` | neither library , raw `count/mean/std/min/max` only |

## How features get out

- **BioSPPy** - `_extract_features` keeps scalar fields as-is and turns numeric
  arrays (`rpeaks`, `heart_rate`, …) into `<name>_count/_mean/_std/_min/_max`. →
  `biosppyFeatures`.
- **NeuroKit2** - `extract_neurokit2_features` flattens every finite scalar in
  `info`, summarizes numeric arrays in `info` the same way, flattens the whole
  `hrv` row, and lets the EOG `derivedFeatures` override. → `neurokit2Features`.
- **Outputs**
  - `analysis.json` - full nested result per segment/channel; library
    `filtered` / `*_Clean` arrays are pruned above 10 k samples.
  - `summary.csv` - one row per segment/channel (per PCG window): stats of the
    raw samples + which libraries ran.
  - `features.csv` - long format: `…, library, feature, value`.
  - `channels/CHANNEL_KIND.csv` - the **raw** recorded time series (not the
    library-cleaned signal).

## Mapping to the "four operations" table (Load · Filter · FE · OR)

| Operation | Status | Where |
|---|---|---|
| **Load** | Done (custom JSON-chunk loader feeds both libraries) | `load_chunk_frames`, `channel_series`, `discover_chunk_entries` |
| **Filter** | Done, but **implicit** - happens inside `biosppy.signals.<kind>.<kind>(...)` and inside `nk.<kind>_process` (`<kind>_clean`); only EDA's method is exposed. Cleaned signals are computed but not persisted. | per-signal handlers; `--eda-method` |
| **FE (Feature Extraction)** | Done for both libraries, all signal kinds they support | `_extract_features`, `extract_neurokit2_features`, `nk.hrv`, `_extract_eog_features` |
| **OR (Outlier Removal)** | **Not implemented yet** - no quality-index gating, no `nk.signal_fixpeaks` / ectopic-beat correction, no NaN/clipping repair. HRV is computed from raw detected R-peaks. | - |

## Known limitations TODO yet

1. **High-level convenience functions, library defaults** - `biosppy.signals.ecg.ecg()`,
   `nk.ecg_process()`, etc., not hand-tuned `clean → findpeaks → delineate`.
2. **HRV is ECG-only and from raw R-peaks** - no `nk.signal_fixpeaks` / artifact
   correction; PPG peaks are not passed to `nk.hrv`.
3. **No outlier/artifact rejection** anywhere in the pipeline.
4. **EEG and ACC in BioSPPy receive a single 1-D channel**, but
   `biosppy.signals.eeg.eeg` / `acc.acc` are designed for multi-channel (N×C)
   input - results for those two are whatever the handler does with one column.
5. **PCG windowing (60 s) is a performance workaround**, not methodology;
   per-window outputs are aggregated to a segment-level summary.
6. **Cleaned/filtered signals are computed but not persisted** - channel CSVs
   hold the raw series; the JSON's filtered arrays are dropped past 10 k samples.
