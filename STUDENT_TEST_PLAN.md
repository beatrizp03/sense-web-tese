# ScientISST App Testing Guide

Thank you for helping test the application.

The goal is to evaluate:

* Stability during long acquisitions
* Buffer manager behaviour (continuous saving + pause/resume + stop)
* Performance on different computers
* Export reliability (CSV / PDF)
* Robustness during connection loss
* Maximum acquisition duration supported

---

# Before Starting

1. Open the app
2. Connect the device
3. Use the test settings assigned to you
4. Start recording
5. After each test:
   * Fill the Google Form
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

---

# Required Test Cases

## Test 1 — Standard Stability Test (30 min)

### Goal:
Check if the app works normally in a common session.

### Settings:
* 2 channels
* 1000 Hz
* Graph ON

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

---

## Test 2 — Pause / Resume Buffer Test (35 min)

### Goal:
Check if data saving continues correctly across segments.

### Settings:
* 4 channels
* 1000 Hz
* Graph ON

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
* Final files contain all data

---

## Test 3 — High Load Stress Test (45 min)

### Goal:
Stress the buffer manager with heavy throughput.

### Settings:
* 6 channels
* Highest available sample rate
* Graph ON

### Steps:
1. Start acquisition
2. Run for 45 min
3. Stop
4. Export files

### Check:
* UI lag (compare an external stopwatch with the graph time to detect delay between real time and UI updates)
* Chunk saving stability

---

## Test 4 — Save Only Performance Test (30 min)

### Goal:
Compare performance without graph rendering.

### Settings:
* 6 channels
* Highest sample rate
* Graph OFF - disabled

### Steps:
1. Start acquisition
2. Run 30 min
3. Stop
4. Export files

### Check:
* Better performance than graph ON
* Lower lag

---

## Test 5 — Connection Loss Recovery Test (30+ min)

### Goal:
Check behaviour if device disconnects mid-session.

### Settings:
* 4 channels
* 1000 Hz

### Steps:
1. Start acquisition
2. Record 15 min
3. Disconnect cable / device intentionally
4. Observe app behaviour
5. Reconnect if requested
6. Try export

### Check:
* Correct warning shown
* App does not crash
* Existing data preserved
* CSV still exportable

---

## Test 6 — Start / Stop Repetition Test

### Goal:
Check repeated session handling.

### Settings:
* 6 channels
* 1000 Hz
* 5 Graphs OFF - disabled 
* 1 Graph ON - enabled

### Steps:
Do 5 short sessions:
1. Connect
2. Start
3. Record 5 min
4. Stop
5. Repeat

### Check:
* No memory leak
* No broken sessions
* New folders each time

---

## Test 7 — Robustness / Maximum Duration Test

### Goal:
Find longest stable acquisition time.

### Settings:
* 6 channels
* 1000 Hz
* Graphs OFF 

### Steps:
1. Start acquisition
2. Leave running as long as possible
3. Minimum target: 2 hours
4. If stable, continue longer (note what time it stopped and why)

### Stop when:
* App slows heavily
* Crash
* Freeze
* Memory too high
* End of available time

### Record:
* Total duration achieved
* Any issues near the end

---

# After Each Test

Please send:
* Session folder
* performance.csv
* CSV / PDF exports
* Completed Google Form

---

# Most Important Feedback

Tell me:
1. What broke first
2. What felt slow
3. Which test caused most issues
4. Whether you would trust the app for real use

---

# Quick Advice

Approximate answers are completely fine.
Even “it felt slow after 20 min” is useful data.

---

**Note:** If you wish to perform any additional tests you deem relevant, you are welcome to do so. Please make sure to note the settings you used and the exact steps you followed. You can report these extra tests in the "Test Scenario" question on the forms as "other".
