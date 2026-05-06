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

**Unless a test explicitly says otherwise**, please keep the ScientISST on **battery only** during acquisition. Do not plug in the charger.

**If the battery runs low mid-test:** stop the acquisition, charge the device fully, then restart that test from the beginning. Note this in the Google Form.

---

# Before Starting

**NOTE:** make sure you have a stopwatch to make sure you can compare the lag on the graph UI VS real time.

1. Open the app
2. Make sure the device is unplugged from any charger (unless running Test 8)
3. Connect the device
4. Use the test settings assigned to you (edit them on the settings page)
5. Start recording (make sure you check with the stopwatch to check the lag)
6. After each test:
   * Fill the Google Form (including battery level at start and power state)
   * Run `check_lost_frames.py` on the session folder (_/sense-web-tese/apps/apps/sense-desktop/data/<session_folder>_) and paste the SUMMARY block into the form
   * Send the session folder + CSV + PDF exports (.zip preferred)

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
# Required Test Cases

**IMPORTANT:** during tests, do **NOT** log off, sleep, or suspend the computer. If the computer is logged off or suspended, the app will finish/end the acquisition.

## Test 1 - Standard Stability Test (30 min)

### Settings:
* Sense Device
* 2 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
1. Connect
2. Start acquisition
3. Run for 30 min continuously
4. Stop
5. Export CSV + PDF

### Check:
* Smooth graph
* No freezes
* `check_lost_frames.py` reports zero gaps at both `__seq` and `seq` level ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 2 - Pause / Resume Buffer Test (35 min)

### Settings:
* Sense Device
* 4 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Record 10 min
3. Pause for 1 min
4. Resume
5. Record 10 min
6. Pause again
7. Resume
8. Record final 15 min
9. Stop
10. Export CSV & PDF

### Check:
* Pause works instantly
* Resume works correctly
* No crashes
* Final files contain all three segments of data (one for each start/restart of acquisition)
* `check_lost_frames.py` reports zero gaps within each segment ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 3 - High Load Stress Test, Tab minimized (65 min)

### Settings:
* Sense Device
* 6 channels
* Highest available sample rate
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Leave the live page open the entire time so graphs keep drawing
3. Run for 65 min
4. Stop
5. Export files

### Check:
* UI lag (compare an external stopwatch with the graph time to detect delay between real time and UI updates)
* Chunk saving stability
* `check_lost_frames.py` output ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 4 - High Load Stress Test, Tab minimized (65 min)

### Settings:
* Sense Device
* 6 channels
* Highest available sample rate
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Minimise the window, or switch to another full-screen app so the live graph is not visible
3. Run for 65 min (you can glance at it occasionally but keep the window hidden most of the time)
4. Bring the window back
5. Stop
6. Export files

### Check:
* `check_lost_frames.py` output ([How to Run The Script](#how-to-run-check_lost_framespy))
* Any visible "catch-up" behaviour when you bring the window back up

---

## Test 5 - Connection Loss Recovery Test (30+ min)

### Settings:
* Sense Device
* 4 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Record 15 min
3. Disconnect the device intentionally (turn it off, or move it out of Bluetooth range)
4. Download Files after Disconnection
5. Reconnect 
6. Restart acquisition for 15 min
7. Stop
8. Export CSV & PDF

### Check:
* Correct warning shown
* App does not crash
* Existing data preserved
* CSV still exportable
* `check_lost_frames.py` output ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 6 - Start / Stop Repetition Test

### Settings:
* Sense Device
* 6 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
Do 5 short sessions:
1. Connect
2. Start
3. Record 5 min
4. Stop
5. Repeat

### Check:
* No broken sessions
* New folders each time (5 folders in total)
* `check_lost_frames.py` on each of the 5 session folders reports zero gaps ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 7 - Robustness / Maximum Duration Test

### Settings:
* Sense Device
* 6 channels
* 1000 Hz
* **Power state: Battery only** - if the battery runs out during the test, stop and note the duration reached. Do not plug in the charger mid-test.

### Steps:
1. Start acquisition
2. Leave running as long as possible
    * **Minimum target: 4 hours. Ideal target: 8 hours or until battery ends.**
4. If stable, continue longer (note what time it stopped and why)

### Stop when:
* App slows heavily
* Crash
* Freeze
* Memory too high
* Battery runs out
* End of available time

### Record:
* Total duration achieved
* Any issues near the end
* Whether the session ended due to battery or something else
* `check_lost_frames.py` SUMMARY output ([How to Run The Script](#how-to-run-check_lost_framespy))

---

## Test 8 - Charging Condition Test (30 min)

### Settings:
* Sense Device
* 2 channels (matching Test 1)
* 1000 Hz
* **Power state:** Charger connected throughout the acquisition

### Steps:
1. Plug the device into its charger before starting
2. Connect
3. Start acquisition with the charger still connected
4. Run for 30 min continuously with the charger connected the entire time
5. Stop
6. Export CSV + PDF

### Check:
* Any visible signal degradation on the graph (noise, spikes, flat regions)
* Whether crashes or "invalid byte" errors occur
* Whether the app recovers gracefully from any errors
* Run `check_lost_frames.py` script on the folder created ([How to Run The Script](#how-to-run-check_lost_framespy))

### Also record in the form:
* Charger type (phone charger / laptop-provided USB port / powered hub / other)
* Whether your **laptop** was also plugged into its charger during the test
* Any visible artefacts in the graph, even small ones

---

# How to Run The Script `check_lost_frames.py`

1. Import the _check_lost_frames.py_ script into the ```sense-web-tese/apps/sense-desktop/data``` directory

2. After each test, open a terminal in the ```sense-web-tese/apps/sense-desktop/data``` directory and run:

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

# After Each Test

Please send:
* Session folder (zipped) with:
  * session folder created in _/apps/sense-desktop/data/_
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
6. Any noticeable difference between Test 1 (battery) and Test 8 (charging)
7. Any noticeable difference between Test 3 (graph visible) and Test 4 (graph hidden)

---

# Quick Advice

Approximate answers are completely fine.
Even "it felt slow after 20 min" is useful data.
The numeric outputs from `check_lost_frames.py` are the most important thing - please don't skip that even if you skip some of the subjective questions.

---

**Note:** If you wish to perform any additional tests you deem relevant, you are welcome to do so. Please make sure to note the settings you used, the exact steps you followed, and the power state (battery or charging). You can report these extra tests in the "Test Scenario" question on the forms as "other".