# Sense-Web Architecture Iteration — 2026-03-19

## Real-Time UI and Storage Path

### Current Architecture

```
flowchart TD
    Device -->|Frames| FrameParser
    FrameParser -->|Parsed Frames| FramePublisher
    FramePublisher -->|UI Direct| UI
    FramePublisher -->|Frames| BufferManager
    BufferManager -->|Chunks| StorageSubscriber
    BufferManager -->|Processing Window| ProcessingSubscriber
    StorageSubscriber -->|Finalized Chunks| ChunkedDataWriter
    ProcessingSubscriber -->|Analysis| SignalProcessor
```

- **UI is updated directly from FramePublisher for fastest real-time responsiveness.**
- **BufferManager handles storage chunking and processing, not UI.**
- **UISubscriber is not used in the live UI path, only kept as an artifact.**

## Notes
- This iteration documents the architectural change: UI bypasses BufferManager for speed.
- Previous architecture included BufferManager → UISubscriber → UI.
- This file is created to track progress and design decisions as of 2026-03-19.
