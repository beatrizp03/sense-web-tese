# Sense Architecture — 2026-04-17

## Overview

This document describes the current Sense data acquisition architecture, aligned with the paper-based signal processing pipeline and the recent architectural refinements that moved processing logic out of the renderer.

---

## System Architecture

### Core Data Pipeline

```
Device (Serial/Bluetooth)
    ↓
Frame Parser
    ↓
FramePublisher
    ├→ UI (real-time visualization only)
    ├→ BufferManager
    │    ├→ StorageSubscriber (chunked disk write)
    │    └→ ProcessingSubscriber (signal analysis)
    └→ Electron IPC (if applicable)
```

### Components

- **FramePublisher**: Decouples frame arrival from consumers. Publishes raw frames immediately.
- **BufferManager**: Single source of truth for streaming state. Manages buffers for storage (chunked write) and processing (real-time analysis window).
- **StorageSubscriber**: Writes finalized chunks to disk via Electron ChunkedDataWriter.
- **ProcessingSubscriber**: Real-time signal processing (filtering, feature extraction, analysis).
- **SignalProcessor**: Pure signal processing functions—implements the pipeline described in the research papers.
- **UI**: Consumes frames directly from FramePublisher for low-latency visualization.

---

## Key Architectural Decisions

### 1. **UI Isolation (UI-Only in Renderer)**
The renderer process now handles visualization only. All heavy lifting (processing, buffering, chunking) moved to:
- **Electron Main Process**: Storage, chunking, session management
- **BufferManager/Subscribers**: Real-time processing pipeline (separate from UI)

**Result**: Improved responsiveness, cleaner separation of concerns.

### 2. **No Processing in the Renderer**
- Previous approach: Renderer did UI updates + processing + buffering
- Current approach: Renderer receives only what's needed for visualization
- Processing pipeline is now in a dedicated layer managed by BufferManager

### 3. **Direct UI Publishing (Low Latency)**
- UI bypasses BufferManager for fastest updates
- BufferManager handles storage and processing separately
- Ensures real-time chart updates without blocking on storage/analysis

---

## Data Flow Summary

1. **Acquisition Start**: Device connects, session created, buffers initialized
2. **Frame Reception**: Frames published → UI updated immediately; BufferManager queues for storage/processing
3. **Storage**: Frames buffered → flushed to Electron in chunks → written to disk
4. **Processing**: Real-time analysis window fed to SignalProcessor → results available for downstream analysis
5. **Pause/Resume**: New segment started; buffers maintained; no data loss
6. **Stop**: Final flush; session finalized; metadata saved

---

## Session & Metadata Management

- **Session Metadata**: Stored in localStorage (web) / Electron (desktop)
- **Chunked Frame Storage**: Written to disk by Electron (separate from metadata)
- **Segment Tracking**: Segments created on pause/resume; metadata updated consistently

---

## Alignment with Research

The signal processing pipeline (`SignalProcessor`) implements the methods and techniques described in the original papers. The architecture cleanly separates:
- **Data Acquisition** (FramePublisher)
- **Data Management** (BufferManager, chunking, storage)
- **Signal Analysis** (SignalProcessor, feature extraction, filtering)
- **Presentation** (UI visualization)

This modular design enables extensibility and maintains scientific rigor in the processing pipeline while ensuring responsive user interaction.

---

*Last updated: 2026-04-17*
