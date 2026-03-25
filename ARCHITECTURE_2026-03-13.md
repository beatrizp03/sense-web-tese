# Sense-Web Architecture Overview

## Core Modules

- **FramePublisher**: Emits parsed frames as events. Decouples frame arrival from consumers.
- **BufferManager**: Centralizes all buffering, chunking, and subscriber notification. Owns UI ring buffer, storage chunk buffer, and processing window buffer.
- **UISubscriber**: Stateless adapter for UI updates. Receives buffer window from BufferManager and adapts for chart state.
- **StorageSubscriber**: Stateless adapter for chunk writing and session persistence. Receives finalized chunks from BufferManager and writes to disk/Electron.
- **ProcessingSubscriber**: Stateless adapter for real-time analysis. Receives processing window from BufferManager and calls SignalProcessor.
- **SignalProcessor**: Pure signal processing functions/classes. Implements filtering, feature extraction, and extensible analysis pipeline.
- **SessionManager**: Handles session metadata and segment persistence. Abstracts localStorage logic from main page/component.

## Data Flow

```
Device / SerialPort
   ↓
Frame parser
   ↓
FramePublisher
   ↓
BufferManager
   ├ UISubscriber
   ├ StorageSubscriber
   └ ProcessingSubscriber
```

## Session Lifecycle
- BufferManager handles session start/stop, buffer reset, and chunk finalization.
- SessionManager handles metadata and segment saving.
- StorageSubscriber writes finalized chunks to disk/Electron.

## Reconnection Logic
- Automatic reconnection with exponential backoff in transport layer.
- BufferManager and subscribers reset on reconnect.

## Maintainability
- All business logic is decoupled from UI and main page/component.
- Subscribers are stateless adapters.
- BufferManager is the single source of truth for streaming state.
- SessionManager abstracts persistence.

---
