# ScientISST App Testing Guide

Thank you for helping test the application.

The goal is to evaluate:

* Stability during long acquisitions
* Buffer manager behaviour (continuous saving + pause/resume + stop)
* Performance on different computers
* Export reliability (CSV & PDF)
* Robustness during connection loss
* Maximum acquisition duration supported
* Whether the buffer manager loses any frames (measured, not just felt)

---

# Installation

The installation steps are documented in the GitHub README on the `electron-version` branch (https://github.com/beatrizp03/sense-web-tese/tree/electron-version).
For the Electron desktop app, please use the `sense-desktop` section to see how to install and run the app.

---

# Important - Device Power State

**Unless a test explicitly says otherwise, please keep the ScientISST on battery only during acquisition. Do not plug in the charger.**

**If the battery runs low mid-test:** stop the acquisition, charge the device fully, then restart that test from the beginning. Note this in the Google Form.

---

# Before Starting

**NOTE:** make sure you have a stopwatch to make sure you can compare the lag on the graph UI VS real time.

1. Open the app
2. Make sure the device is unplugged from any charger
3. Connect the device
4. Use the test settings assigned to you
5. Start recording
6. After each test:
   * Fill the Google Form (including battery level at start and power state)
   * Run `check_lost_frames.py` on the session folder (_/sense-web-tese/apps/apps/sense-desktop/data/<session_folder>_) and paste the SUMMARY block into the form
   * Send the session folder (.zip preferred)

---

# What to Observe During All Tests

Please note if any of these happen:

* Graph delay / lag
* Freezes
* App crash
* Buttons slow to react
* Device disconnects
* Export problems
* Missing files
* Slowdowns over time
* Whether the app feels slower at the end of a long test than at the start (and if so, roughly how much)

---
# Required Test Case

**IMPORTANT:** during tests, do **NOT** log off, sleep, or suspend the computer. If the computer is logged off or suspended, the app will finish/end the acquisition.

## Pilot Test 1 - Standard Stability Test (35 min)

### Settings:
* Sense Device
* 4 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Record 15 min
3. Pause
4. Resume
5. Record 20 min
6. Stop
7. Export CSV & PDF

### Check:
* Pause works instantly
* Resume works correctly
* No crashes
* Final files contain all two segments of data (one for each start/restart of acquisition)
* `check_lost_frames.py` reports zero gaps within each segment (gaps across segment boundaries are expected and the script handles them correctly)

---

# How to Run `check_lost_frames.py`

After each test, open a terminal in the app's install folder (```sense-web-tese/apps/sense-desktop/data``` directory) and run:

```
python check_lost_frames.py <session_folder_name>
```
For example: ```python check_lost_frames.py 2026-05-04T12-12-51-794Z ```

The script prints a SUMMARY block at the end that looks like this:

```
═══════════════════════════════════════════════════════
  SUMMARY
═══════════════════════════════════════════════════════
  [__seq]  ✅ No frames lost at IPC/buffer level
  [seq]    ✅ No frames lost at device/transmission level
═══════════════════════════════════════════════════════
```

Copy that block and paste it into the Google Form. If you see `❌` instead of `✅`, copy the full summary (including the gap counts) so we can analyse what happened.

---

# After the Test

Please send:
* Session folder (zipped)
* CSV & PDF exports
* Completed Google Form, which should include:
  * Power state and battery level at start
  * `check_lost_frames.py` SUMMARY output
  * Charger details (on the forms)
  * Any issues encountered

---

# Most Important Feedback

Tell me:
1. What broke first
2. What felt slow
3. Which test caused most issues
4. Whether the app felt slower at the end of a long test than at the start (and if so, roughly how much)
5. Whether you would trust the app for real use

---

# Quick Advice

Approximate answers are completely fine.
Even "it felt slow after 20 min" is useful data.
The numeric outputs from `check_lost_frames.py`are the most important thing - please don't skip that even if you skip some of the subjective questions.

---

**Note:** If you wish to perform any additional tests you deem relevant, you are welcome to do so. Please make sure to note the settings you used, the exact steps you followed, and the power state (battery or charging). You can report these extra tests in the "Test Scenario" question on the forms as "other".