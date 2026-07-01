# Annotation Decisions

This document records decisions about scope naming and zero-width interval behavior for the annotation feature.

## Scope naming
- Decision: use `record` as the top-level scope name for whole-record annotations.
- Rationale: the project already uses the term `segment` to mean pause/resume acquisition chunks; using `record` (or `session`) avoids collision. `record` is recommended because it maps naturally to an exported recording unit.
- Impact: sidecar `annotations` use `scope` values `channel` or `record`.

## Zero-width interval policy
- Decision: accept `t0 == t1` as an explicit point annotation.
- Editor behavior: when a user resizes an interval to zero width the editor will present two options (configurable in Settings):
  1. Accept as point (default): the interval collapses to a point and the persisted annotation will have `t0 == t1`.
  2. Snap to nearest sample width: the editor will snap the interval to the nearest sample width (>0) to avoid creating a zero-width interval.
- Guidance: the default is to accept zero-width as an explicit point because it simplifies the storage model and CSV export. The snap behavior can be enabled by users who prefer not to create points via resize.

## Timestamp unit
- Decision: use milliseconds since recording start for `t0` and `t1` in sidecars and `annotations.csv`.
- Rationale: ms is human readable and precise enough for target sampling rates; `sampleRate` will be included in the sidecar header for conversions if needed.

## Labels lifecycle and extensibility
- Canonical labels (IDs under 1000) are fixed for interoperability.
- User-defined labels are allowed but must be assigned IDs in a reserved range (>=1000) and included in the local `labels.json` sidecar so exports remain decodable.

## Acceptance criteria
- The `design/annotation-vocab.md` file lists canonical labels with IDs, colors, and `appliesTo`.
- The `design/annotation-decision.md` file documents the scope decision, zero-width policy, timestamp unit, and label extensibility rules.