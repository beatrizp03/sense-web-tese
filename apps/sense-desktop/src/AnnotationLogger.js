const fs = require('fs');

/**
 * AnnotationLogger — records annotation-workflow events and their cost for a
 * single session to a CSV file (annotation-log.csv), one row per user action.
 *
 * ── Columns ─────────────────────────────────────────────────────────────────
 *
 *   timestamp          ISO-8601 wall-clock time (millisecond precision) of the
 *                      action. Lets you compute inter-action intervals.
 *
 *   elapsed_ms         Milliseconds since this logger instance was created (i.e.
 *                      since the first action of the current app run for this
 *                      session). Resets across app restarts.
 *
 *   action             The kind of operation, as a discrete token for easy
 *                      filtering/aggregation. Values:
 *                        create   — an annotation was placed
 *                        remove   — a single annotation was deleted
 *                        clear    — annotations in a range were bulk-removed
 *                        relabel  — an annotation's label was changed
 *                        note     — an annotation's note was edited
 *                        edit     — an annotation's bounds were moved/resized
 *                        save     — annotations were persisted to disk
 *                        export   — annotations were exported to CSV
 *                        import   — annotations/labels were loaded from disk
 *
 *   duration_ms        Wall-clock milliseconds the action took (measured in the
 *                      renderer).
 *
 *   annotation_count   How many annotations exist after the action.
 * 
 *   rss_mb             Resident Set Size of the Electron main process (MB).
 *   heap_used_mb       V8 heap in use by the main process (MB).
 *
 *   detail             Optional small JSON blob with extra context (labelId,
 *                      segment, …). CSV-escaped.
 */
class AnnotationLogger {
  /**
   * @param {string} outputPath  Full path for the output CSV file
   */
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.startTime = Date.now();
    this.header =
      'timestamp,elapsed_ms,action,duration_ms,annotation_count,' +
      'rss_mb,heap_used_mb,detail\n';
  }

  _ensureHeader() {
    if (!fs.existsSync(this.outputPath)) {
      fs.writeFileSync(this.outputPath, this.header);
    }
  }

  /**
   * Append a single annotation event row with a memory snapshot.
   * @param {object} evt
   * @param {string} evt.action            One of the action tokens above.
   * @param {number} [evt.durationMs]      How long the action took (ms).
   * @param {number} [evt.annotationCount] Annotation count after the action.
   * @param {*}      [evt.detail]          Extra context (object or string).
   */
  logEvent({ action, durationMs, annotationCount, detail } = {}) {
    try {
      this._ensureHeader();
      const now = Date.now();

      const mem = process.memoryUsage();
      const rssMB = (mem.rss / 1048576).toFixed(2);
      const heapUsedMB = (mem.heapUsed / 1048576).toFixed(2);

      const row = [
        new Date(now).toISOString(),
        now - this.startTime,
        action || '',
        durationMs != null && Number.isFinite(durationMs) ? Math.round(durationMs) : '',
        annotationCount != null && Number.isFinite(annotationCount) ? annotationCount : '',
        rssMB,
        heapUsedMB,
        csvField(detail),
      ].join(',');

      fs.appendFileSync(this.outputPath, row + '\n');
    } catch (err) {
      console.error('[AnnotationLogger] Failed to log event:', err);
    }
  }
}

function csvField(value) {
  if (value == null || value === '') return '';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = AnnotationLogger;
