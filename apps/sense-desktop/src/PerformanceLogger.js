const fs = require('fs');

/**
 * PerformanceLogger — records system resource usage and key app event timings
 * for a single acquisition session to a CSV file (performance.csv).
 *
 * The file has two kinds of rows:
 *
 *   PERIODIC SAMPLE rows  (written every `intervalMs`, default 1 s)
 *     These give a continuous picture of how the app is using the machine
 *     while acquisition is running. Use them to spot memory growth over a long
 *     session, CPU spikes during chunk writes, or renderer memory leaks.
 *
 *   EVENT rows  (written on demand via logEvent())
 *     These mark the exact moment a user-visible operation completed, together
 *     with how long it took. The `event_duration_ms` value is wall-clock ms
 *     from when the operation started to when it finished. Use them to measure
 *     the responsiveness of the app at each stage of a session.
 *
 * ── Columns ─────────────────────────────────────────────────────────────────
 *
 *   timestamp           ISO-8601 wall-clock time of this row.
 *
 *   elapsed_ms          Milliseconds since the logger was started (i.e. since
 *                       the session folder was created). Useful for aligning
 *                       rows with the acquisition timeline.
 *
 *   main_rss_mb         Resident Set Size of the Electron main process in MB.
 *                       This is all physical RAM the process currently holds,
 *                       including V8 heap, native buffers, and mapped files.
 *                       Watch for unbounded growth — it indicates a memory leak
 *                       in the main-process chunk pipeline.
 *
 *   main_heap_used_mb   V8 heap actually in use by the main process in MB.
 *                       Lower than rss; the difference is native/buffer memory.
 *                       A heap that never shrinks after chunk writes suggests
 *                       objects are not being garbage-collected.
 *
 *   main_cpu_user_pct   Main process user-space CPU % since the previous sample.
 *                       Spikes here during acquisition mean JS is doing heavy
 *                       work (e.g. JSON serialisation of a large chunk).
 *
 *   main_cpu_sys_pct    Main process kernel-space CPU % since the previous
 *                       sample. Spikes here point to I/O pressure — the OS is
 *                       busy writing chunk files to disk on behalf of the app.
 *
 *   renderer_ws_mb      Working-set size of the Chromium renderer (Tab) process
 *                       in MB, read from app.getAppMetrics(). This is the RAM
 *                       used by the Next.js/React UI, canvas charts, and the
 *                       frame graph buffer. High values here mean the UI is
 *                       accumulating too many frames in memory.
 *
 *   renderer_cpu_pct    CPU % of the renderer process from app.getAppMetrics().
 *                       Sustained high values while acquiring mean the canvas
 *                       chart or React renders are too expensive.
 *
 *   event               Name of the operation that completed on this row.
 *                       Empty for periodic sample rows. Possible values:
 *                         device_connect    — serial/BT handshake to the board
 *                         acquisition_start — from Start click to first frame
 *                         acquisition_end   — from Stop click to session saved
 *                         acquisition_pause — time to pause (stop device, flush chunk)
 *                         acquisition_resume — time to resume (register segment, restart device)
 *                         csv_export        — from button click to file saved
 *                         pdf_export        — from button click to file saved
 *
 *   event_duration_ms   Wall-clock milliseconds the operation took. Empty for
 *                       periodic sample rows. Compare across sessions to track
 *                       whether exports are getting slower as session size grows.
 */
class PerformanceLogger {
  /**
   * @param {string} outputPath  Full path for the output CSV file
   * @param {number} intervalMs  Sampling interval in milliseconds (default 1000)
   */
  constructor(outputPath, intervalMs = 1000) {
    this.outputPath = outputPath;
    this.intervalMs = intervalMs;
    this.stream = null;
    this.timer = null;
    this.startTime = null;
    this.prevCpuUsage = null;
    this.prevTime = null;
  }

  start() {
    this.stream = fs.createWriteStream(this.outputPath, { flags: 'w' });
    this.stream.write(
      'timestamp,elapsed_ms,' +
      'main_rss_mb,main_heap_used_mb,' +
      'main_cpu_user_pct,main_cpu_sys_pct,' +
      'renderer_ws_mb,renderer_cpu_pct,' +
      'event,event_duration_ms\n'
    );
    this.startTime = Date.now();
    this.prevCpuUsage = process.cpuUsage();
    this.prevTime = Date.now();
    this.timer = setInterval(() => this._sample(), this.intervalMs);
    console.log(`[PerformanceLogger] Logging to ${this.outputPath} every ${this.intervalMs}ms`);
  }

  _sample() {
    const now = Date.now();
    const elapsed = now - this.startTime;

    // ── Main process memory ─────────────────────────────────────────────
    const mem = process.memoryUsage();
    const rssMB      = (mem.rss      / 1048576).toFixed(2); // bytes → MB
    const heapUsedMB = (mem.heapUsed / 1048576).toFixed(2);

    // ── Main process CPU (delta since last sample) ──────────────────────
    // process.cpuUsage(prev) returns microseconds of user/system CPU since
    // prev was captured; divide by elapsed microseconds to get a ratio → %
    const cpuDelta  = process.cpuUsage(this.prevCpuUsage);
    const elapsedUs = (now - this.prevTime) * 1000; // ms → µs
    const cpuUser   = ((cpuDelta.user   / elapsedUs) * 100).toFixed(2);
    const cpuSys    = ((cpuDelta.system / elapsedUs) * 100).toFixed(2);
    this.prevCpuUsage = process.cpuUsage();
    this.prevTime = now;

    // ── Renderer process (Electron app metrics) ──────────────────────────
    // app.getAppMetrics() covers every Chromium process (Tab = renderer, GPU…)
    // memory.workingSetSize is in KB; cpu.percentCPUUsage is already a %
    let rendererWsMB = '';
    let rendererCpu  = '';
    try {
      const { app } = require('electron');
      const metrics = app.getAppMetrics();
      const renderer = metrics.find(m => m.type === 'Tab' || m.type === 'renderer');
      if (renderer) {
        rendererWsMB = (renderer.memory.workingSetSize / 1024).toFixed(2); // KB → MB
        rendererCpu  = renderer.cpu.percentCPUUsage.toFixed(2);
      }
    } catch (_) {
      // getAppMetrics may not be available during shutdown
    }

    const row = [
      new Date(now).toISOString(),
      elapsed,
      rssMB, heapUsedMB,
      cpuUser, cpuSys,
      rendererWsMB, rendererCpu,
      '', ''
    ].join(',');

    this.stream.write(row + '\n');
  }

  /**
   * Write a single event row with a snapshot of current metrics.
   * @param {string} name         Event label (e.g. 'device_connect')
   * @param {number} [durationMs] How long the operation took in ms
   */
  logEvent(name, durationMs) {
    if (!this.stream) return;
    const now = Date.now();
    const elapsed = now - this.startTime;

    const mem = process.memoryUsage();
    const rssMB      = (mem.rss      / 1048576).toFixed(2);
    const heapUsedMB = (mem.heapUsed / 1048576).toFixed(2);

    const cpuDelta  = process.cpuUsage(this.prevCpuUsage);
    const elapsedUs = (now - this.prevTime) * 1000;
    const cpuUser   = ((cpuDelta.user   / elapsedUs) * 100).toFixed(2);
    const cpuSys    = ((cpuDelta.system / elapsedUs) * 100).toFixed(2);
    this.prevCpuUsage = process.cpuUsage();
    this.prevTime = now;

    let rendererWsMB = '';
    let rendererCpu  = '';
    try {
      const { app } = require('electron');
      const metrics = app.getAppMetrics();
      const renderer = metrics.find(m => m.type === 'Tab' || m.type === 'renderer');
      if (renderer) {
        rendererWsMB = (renderer.memory.workingSetSize / 1024).toFixed(2);
        rendererCpu  = renderer.cpu.percentCPUUsage.toFixed(2);
      }
    } catch (_) {}

    const row = [
      new Date(now).toISOString(),
      elapsed,
      rssMB, heapUsedMB,
      cpuUser, cpuSys,
      rendererWsMB, rendererCpu,
      name,
      durationMs !== undefined ? durationMs : ''
    ].join(',');

    this.stream.write(row + '\n');
    console.log(`[PerformanceLogger] Event: ${name}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this._sample(); // flush one final sample before closing
      this.stream.end();
      this.stream = null;
    }
    console.log('[PerformanceLogger] Stopped.');
  }
}

module.exports = PerformanceLogger;
