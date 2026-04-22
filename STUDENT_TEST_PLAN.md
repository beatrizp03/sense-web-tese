# ScientISST App Testing Guide

Thank you for helping test the application.

The goal is to evaluate:

* Stability during long acquisitions
* Buffer manager behaviour (continuous saving + pause/resume + stop)
* Performance on different computers
* Export reliability (CSV / PDF)
* Robustness during connection loss
* Maximum acquisition duration supported
* Whether the buffer manager loses any frames (measured, not just felt)

---

# Important - Device Power State

**Unless a test explicitly says otherwise (only Test 8), please keep the ScientISST on battery only during acquisition. Do not plug in the charger.**

Charging during acquisition can introduce electrical and RF interference that degrades signal quality, and we want to measure the app's performance separately from that effect. Test 8 is dedicated to the charging condition and will tell us how much the charger affects things.

**If the battery runs low mid-test:** stop the acquisition, charge the device fully, then restart that test from the beginning. Note this in the Google Form.

---

# Before Starting

**NOTE:** make sure you have a stopwatch to make sure you cam compare the lag on the graph UI VS real time.
1. Open the app
2. Make sure the device is unplugged from any charger (unless running Test 8)
3. Connect the device
4. Use the test settings assigned to you
5. Start recording
6. After each test:
   * Fill the Google Form (including battery level at start and power state)
   * Run `check_lost_frames.py` on the session folder and paste the SUMMARY block into the form
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

# How to Run `check_lost_frames.py`

After each test, open a terminal in the app's install folder and run:

```
python check_lost_frames.py <path_to_session_folder>
```

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

# Required Test Cases

## Test 1 - Standard Stability Test (30 min)

### Settings:
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
* Files created correctly
* `check_lost_frames.py` reports zero gaps at both `__seq` and `seq` level

---

## Test 2 - Pause / Resume Buffer Test (35 min)

### Settings:
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
10. Export CSV/PDF

### Check:
* Pause works instantly
* Resume works correctly
* No crashes
* Final files contain all three segments of data
* `check_lost_frames.py` reports zero gaps within each segment (gaps across segment boundaries are expected and the script handles them correctly)

---

## Test 3 - High Load Stress Test, Tab not Overlapped (45 min)

### Settings:
* 8 channels
* Highest available sample rate
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Leave the live page open the entire time so graphs keep drawing
3. Run for 45 min
4. Stop
5. Export files

### Check:
* UI lag (compare an external stopwatch with the graph time to detect delay between real time and UI updates)
* Chunk saving stability
* `check_lost_frames.py` output - this is the most important test for validating the buffer manager under load

---

## Test 4 - High Load Stress Test, Tab Overlapped (45 min)

### Settings:
* 8 channels
* Highest available sample rate
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Minimise the window, or switch to another full-screen app so the live graph is not visible
3. Run for 45 min (you can glance at it occasionally but keep the window hidden most of the time)
4. Bring the window back
5. Stop
6. Export files

### Check:
* `check_lost_frames.py` output 
* Any visible "catch-up" behaviour when you bring the window back

---

## Test 5 - Connection Loss Recovery Test (30+ min)

### Settings:
* 4 channels
* 1000 Hz
* **Power state: Battery only**

### Steps:
1. Start acquisition
2. Record 15 min
3. Disconnect the device intentionally (turn it off, or move it out of Bluetooth range)
4. Observe app behaviour
5. Reconnect if requested
6. Try export

### Check:
* Correct warning shown
* App does not crash
* Existing data preserved
* CSV still exportable
* `check_lost_frames.py` reports the data up to the disconnection point is intact

---

## Test 6 - Start / Stop Repetition Test

### Settings:
* 8 channels
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
* New folders each time
* `check_lost_frames.py` on each of the 5 session folders reports zero gaps

---

## Test 7 - Robustness / Maximum Duration Test

### Settings:
* 8 channels
* 1000 Hz
* **Power state: Battery only** - if the battery runs out during the test, stop and note the duration reached. Do not plug in the charger mid-test.

### Steps:
1. Start acquisition
2. Leave running as long as possible
3. **Minimum target: 4 hours. Ideal target: 8 hours or until battery ends.**
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
* `check_lost_frames.py` SUMMARY output
* Total chunk count (count the `sample*_chunk*.json` files in the session folder)

---

## Test 8 - Charging Condition Test (30 min)

### Settings:
* 2 channels (matching Test 1)
* 1000 Hz
* **Power state: Charger connected throughout the acquisition**

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
* Compare `check_lost_frames.py` output against Test 1 - specifically, compare `seq` gaps (transmission-level) and `__seq` gaps (software/buffer-level) between the two. We expect `seq` gaps may increase while charging (hardware noise) but `__seq` gaps should stay at zero (software unaffected)

### Also record in the form:
* Charger type (phone charger / laptop-provided USB port / powered hub / other)
* Whether your **laptop** was also plugged into its charger during the test
* Any visible artefacts in the graph, even small ones

---

# After Each Test

Please send:
* Session folder (zipped)
* `performance.csv`
* CSV / PDF exports
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
The numeric outputs from `check_lost_frames.py` and `performance.csv` are the most important thing - please don't skip those even if you skip some of the subjective questions.

---

**Note:** If you wish to perform any additional tests you deem relevant, you are welcome to do so. Please make sure to note the settings you used, the exact steps you followed, and the power state (battery or charging). You can report these extra tests in the "Test Scenario" question on the forms as "other".