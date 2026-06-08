# Annotation Vocabulary

This document lists the predefined labels for annotations, their IDs, categories, descriptions, display color, and the scope they apply to.

Schema fields for each label:
- id: integer unique identifier
- name: short machine-friendly name
- category: high-level grouping (quality, event, feature, state, class)
- description: human-readable description
- color: hex color for UI display
- appliesTo: `channel` | `record` (what the label attaches to)

| id | name         | category | description                                      | color    | appliesTo |
|----|--------------|----------|--------------------------------------------------|----------|-----------|
| 1  | noise        | quality  | Junk / noise to ignore (artifacts)              | #9AA0A6  | channel   |
| 2  | disturbance  | quality  | Disruption to protocol execution                | #E0691F  | channel   |
| 3  | stimulus     | event    | External stimulus (beep, trigger, marker)       | #378ADD  | channel   |
| 4  | onset        | event    | Start of an event                               | #3FA66A  | channel   |
| 5  | offset       | event    | End of an event                                 | #3FA66A  | channel   |
| 6  | peak         | feature  | Local maximum / feature point                   | #7C5CD6  | channel   |
| 7  | baseline     | state    | Calm / resting baseline                         | #888780  | channel   |
| 8  | movement     | quality  | Subject movement affecting signal quality       | #FFB86B  | channel   |
| 20 | healthy      | class    | Healthy control (record-level label)            | #3FA66A  | record    |
| 21 | sick         | class    | Patient / clinical case (record-level label)    | #C0392B  | record    |

Notes
- The `appliesTo` field allows the UI and import logic to restrict which labels can be assigned to channel annotations vs record-level annotations.
- IDs are fixed in the canonical vocabulary for interoperability and export reproducibility. If the system supports user-extended vocabularies, new labels must get IDs in a documented user range (e.g. >=1000) and be stored in the sidecar `labels.json`.
- Colors are defaults for UI; apps may allow users to choose alternate palettes but exports reference `labelId` only (colors serialized in `labels.json`).

Example `labels.json` snippet

```
{
  "schemaVersion": 1,
  "labels": [
    { "id": 1, "name": "noise", "category": "quality", "description": "Junk/noise to ignore", "color": "#9AA0A6", "appliesTo": "channel" },
    { "id": 2, "name": "disturbance", "category": "quality", "description": "Disruption to protocol execution", "color": "#E0691F", "appliesTo": "channel" }
  ]
}
```
