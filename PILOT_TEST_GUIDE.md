# Pilot Test Validation Guide

**Purpose:** Before distributing the test plan to your real testers, run 1-2 pilot sessions with friends/family. The goal of a pilot is **not** to collect performance data — it is to find every place where a tester could get stuck, confused, or need to message you. If the pilot tester can complete everything start to finish *without asking you a single question*, your materials are ready.

This guide gives you a checklist to run before, during, and after each pilot.

---

## How to use this guide

1. Pick a pilot tester who has **never seen the project before** (a friend or family member with roughly the same technical comfort level as your real testers).
2. Hand them only the materials your real testers will receive: `STUDENT_TEST_PLAN.md`, the Google Form link, `check_lost_frames.py`, the GitHub link, and whatever ID you assigned them.
3. **Do not help them** unless they get truly stuck. Every question they ask is a gap in your materials — write it down.
4. After they finish, run through the post-pilot checklist with them and update your materials before sending to real testers.

You only need to pilot **one short test** per pilot tester (Test 1 or Test 6 are the best candidates — Test 1 because it's the baseline, Test 6 because it exercises start/stop/folder creation 5 times in a row). You don't need them to run all 8 tests.

---

## A. Pre-pilot sanity check (do this yourself, before involving anyone)

Before any pilot tester touches your materials, run through this list yourself on a clean machine — ideally one that is **not** your dev machine. A second laptop, a friend's computer, or a fresh VM is ideal because it surfaces "works on my machine" assumptions.

### A.1 — The materials package
- [ ] The GitHub README on the `electron-version` branch has a `sense-desktop` section, and the install steps in it actually work on a fresh machine.
- [ ] The README mentions every prerequisite (Node version, Python version, any system libraries, driver requirements for the device).
- [ ] `STUDENT_TEST_PLAN.md` and the Google Form link are both reachable via the channel you'll send them on (Discord, email, etc.).
- [ ] `check_lost_frames.py` is included in the install folder *or* the test plan tells the tester exactly where to find it.
- [ ] You know which test ID and which test number each pilot tester will run, and you've told them in the same format the real testers will get.

### A.2 — Self-run a full Test 1 end-to-end
On the non-dev machine, do exactly what the test plan says — no shortcuts.
- [ ] Install from the README, no extra steps.
- [ ] Connect device on battery.
- [ ] Run a full 30 min Test 1.
- [ ] Stop, export CSV, export PDF.
- [ ] Run `check_lost_frames.py` on the session folder using the exact command from the test plan.
- [ ] The SUMMARY block prints in the format the form expects.
- [ ] Confirm `performance.csv` exists in the session folder.
- [ ] Confirm the session folder name matches the format the form asks for (`2026-04-17T10-19-49-191Z`-style).
- [ ] Zip the session folder and confirm the zip opens cleanly.

If any of these failed for *you*, fix it before involving a pilot tester.

### A.3 — Walk through the Google Form yourself
Open the form in a private/incognito window and try to fill it in for the Test 1 you just ran. As you do, ask:
- [ ] Every required field can actually be answered from what the test plan tells the tester to record.
- [ ] No question references something the test plan never mentions (e.g. asking for "battery level at start" — does the test plan tell them to record this?).
- [ ] Field 9 ("Number of the Session") is clear about what the tester should paste — the test plan should explicitly tell them where this name comes from.
- [ ] Field 30 (the `check_lost_frames.py` SUMMARY field) accepts the multi-line block exactly as the script outputs it (no character limit issues, no formatting that breaks).
- [ ] If "Charger type" is required only for Test 8, the form's conditional logic actually skips it for other tests — or, if it doesn't, the test plan tells testers what to put.
- [ ] No required field is impossible to answer for some test (e.g. "Did Pause/Resume work?" should have a "Not Tested" option for tests that don't use pause/resume — the form already has this for the connection-loss question, double-check the others).

---

## B. Things to watch for during the pilot

Sit nearby (or stay on a call) but **do not intervene unless they are completely blocked**. Take notes silently. The most valuable data you'll get is the moments where they hesitate, re-read, or look confused.

### B.1 — Pre-acquisition phase
- [ ] Did they install successfully without messaging you?
- [ ] Did they understand which test they were assigned and which settings to use?
- [ ] Did they know where to find the test plan and the form?
- [ ] Did they understand the battery-only requirement before pressing Start? (Common pilot failure: they leave the device plugged in because they didn't read the "Important" section.)
- [ ] Did they remember to have a stopwatch ready?

### B.2 — During acquisition
- [ ] Did they know when they were "done" and when to stop?
- [ ] For pause/resume tests: did they know how to pause and resume in the app?
- [ ] Did they accidentally close, sleep, or log out the computer? (If yes, your warning needs to be more prominent.)
- [ ] Did they understand what "tab overlapped" vs "tab not overlapped" means in Tests 3 and 4?

### B.3 — Post-acquisition phase
- [ ] Did they find the session folder on disk without asking?
- [ ] Did they successfully export CSV and PDF?
- [ ] Did they run `check_lost_frames.py` correctly the first time? Note the *exact* command they typed — if they had to guess at the path, the test plan needs a clearer example.
- [ ] Did they correctly identify the SUMMARY block to copy into the form?
- [ ] Did they zip and send the session folder without further instructions?

### B.4 — While filling the form
- [ ] Did they understand the ID format (e.g. `User1_test3`)?
- [ ] Did any question make them pause and ask "what does this mean"?
- [ ] Did the SUS questions (34-43) read clearly to them, or did the wording trip them up? (Also check for typos: "dificult" in Q41, "I think I would need technical support to use it" — make sure the polarity is consistent across questions.)
- [ ] Did they know what to enter for the "session number" question?

---

## C. The two-question pilot debrief

After they finish, ask only these two questions before showing them this guide:

1. **"At any point, did you feel unsure what to do next? When?"**
2. **"If I gave you this exact same package tomorrow with no help from me at all, could you do it?"**

If the answer to #2 is anything other than a confident yes, you have work to do.

Then run through the checklists in section B with them and ask: *"For each of these, did you actually do it, and was it clear from what I sent you?"*

---

## D. Issues to fix before the real tests

After the pilot, your test plan and form are ready to go to real testers when **all of these are true**:

- [ ] The pilot tester completed the full flow (install → run → export → script → form → zip → send) without messaging you.
- [ ] Every question they asked during the pilot has been answered by an edit to the test plan or form.
- [ ] You have not had to clarify anything verbally that isn't now in writing.
- [ ] The form accepts the SUMMARY block from the script in its real output format.
- [ ] All required form fields are answerable from what the test plan tells testers to record.
- [ ] The test plan's "Power state" instruction is impossible to miss (the pilot tester remembered it without prompting).
- [ ] The session folder name format expected by the form matches what the app actually creates.
- [ ] You've tested the install on a machine that is not your dev machine.

---

## E. Optional: a second pilot

If the first pilot surfaced more than 2-3 material issues, run a second pilot with a different person after fixing them. The second pilot's job is to confirm your fixes work — if *they* also have to ask questions, the materials still aren't ready. If the second pilot completes everything cleanly, you're good to send to your real testers.

---

## Quick reference — common pilot failure modes

These are the issues most likely to surface in a pilot of a study like yours. Watch for them specifically:

- **Path/install confusion** — tester runs `check_lost_frames.py` from the wrong directory.
- **Battery instruction missed** — tester runs the test with charger plugged in for Tests 1-7.
- **Missing prerequisite** — Python not installed, or wrong version, and the test plan didn't say to install it.
- **Form field mismatch** — tester records something during the test that the form never asks for, or the form asks for something the test plan never told them to record.
- **Session folder confusion** — tester can't find the session folder, doesn't know which file to zip, or zips the wrong thing.
- **Stopwatch forgotten** — tester gets to a graph-lag question with no real-time reference.
- **Sleep/lock accident** — laptop goes to sleep mid-acquisition and ruins the long tests.
- **Ambiguous test settings** — "highest available sample rate" is unclear if the device offers several.
