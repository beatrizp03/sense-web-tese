# ScientISST App Testing Guide

Thanks for helping test the app!

The goal is to push the app through long and heavy acquisitions and **measure** whether it loses any data (not just how it feels). We're checking: stability, the buffer manager (continuous saving + pause/resume/stop), exports (CSV & PDF), connection-loss recovery, and maximum duration.

---

## Setup (once)

- **Install** from the README on the [`testing` branch](https://github.com/beatrizp03/sense-web-tese/tree/testing) → follow the `sense-desktop` section.
- Keep the ScientISST on **battery only** (except Test 8). If the battery gets low mid-test: stop, fully charge, restart that test from the beginning, and note it in the form.
- Have a **stopwatch** handy to compare real time against the on-screen graph.

## The routine (every test)

1. Unplug the charger (except Test 8), connect the device, and apply your assigned settings on the **Settings** page.
2. Start recording — glance at the stopwatch vs the graph to spot lag.
3. When done, **Stop** and export **CSV + PDF**.
4. Run `check_lost_frames.py` ([how-to below](#running-check_lost_framespy)) and paste the SUMMARY into the Google Form.
5. Send the zipped session folder (`apps/sense-desktop/data/<folder>`) + exports + the form (include battery level, power state, and anything weird you saw).

> ⚠️ **Don't log off, sleep, or suspend the computer during a test** — it ends the acquisition.

## What to search for during testing?

Graph lag, freezes, crashes, slow buttons, disconnects, export/missing-file problems, and whether the app feels slower at the end than at the start (roughly how much?).

---

## The tests

All tests use the **Sense device** on **battery** (except Test 8) and follow the routine above. The table below is just what's unique to each.

| # | Test | Channel(s) | Rate | Duration | Extra steps & what to check |
|---|---|---|---|---|---|
| 1 | Standard stability | 2 | 1000 | 30 min | Baseline. Expect a smooth graph, no freezes, **zero gaps**. |
| 2 | Pause / resume | 4 | 1000 | ~35 min | Record 10 min → pause 1 min → resume → 10 min → pause → resume → 15 min → stop. File must contain **all 3 segments**; zero gaps within each. |
| 3 | High load, **1 channel** | 1 (AI1) | 16000 | 65 min | Keep the live page **visible** the whole time. Check UI lag (stopwatch vs graph) and chunk-saving stability. |
| 4 | High load, **6 channels** | 6 | 4000 | 65 min | **Minimise/hide** the window the whole time, then bring it back. Watch for "catch-up" behaviour on return. |
| 5 | Connection loss | 4 | 1000 | 30+ min | 15 min → kill the link (power off the device or leave BT range) → download files → reconnect → 15 min. Expect a warning, no crash, data preserved, CSV still exports. |
| 6 | Start / stop ×5 | 6 | 1000 | 5 × 5 min | Five separate record→stop sessions = **five folders**, each with zero gaps. |
| 7 | Max duration | 6 | 1000 | as long as possible | Run until it breaks or the battery dies. **Target ≥4 h, ideally 8 h.** Note total duration, why it stopped, and any slowdown/freeze/crash/high-memory near the end. |
| 8 | Charging robustness | 2 | 1000 | 30 min | **Charger connected the entire time** (use your usual Bluetooth connection, so USB is power-only). Checks the app stays healthy while charging — watch for **"invalid byte" errors**, crashes/freezes, and whether it **recovers**. Run `check_lost_frames` as usual. Note charger type and whether your laptop was also plugged in. (See note below.) |

**Test 8 note:** this is an **app-robustness** check, not a signal-quality one — without a controlled signal source we can't fairly judge whether the *waveform* degrades, so just report any app errors/crashes (frame counts are expected to be unchanged). ⚠️ For safety, **never attach electrodes to a person while the charger is connected** (USB power can put unsafe voltage on the inputs).

---

## Running `check_lost_frames.py`

Put `check_lost_frames.py` in `sense-web-tese/apps/sense-desktop/data`, open a terminal there, and run:

```
python check_lost_frames.py <session_folder_name>
```

e.g. `python check_lost_frames.py 2026-05-04T12-12-51-794Z`

Copy the SUMMARY block into the form:

```
═══════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════
  [__seq]  ✅ No frames lost at IPC/buffer level
  [seq]    ✅ No frames lost at device/transmission level
═══════════════════════════════════════════════════════
```

If you see `❌`, paste the **full** summary (with the gap counts) so we can dig in. These numbers are the single most important output — please don't skip them, even if you skip the subjective questions.

---

## Feedback that matters most

1. What broke first, and what felt slow?
2. Which test caused the most issues?
3. Did the app feel slower at the end of a long test than at the start (roughly how much)?
4. Would you trust the app for real use?

Approximate answers are completely fine — even "it felt slow after 20 min" is useful.

> **Extra tests welcome.** If you try anything else, note the settings, exact steps, and power state, and report it under "other" in the form.
