```
flowchart TD
    Device -->|Frames| FrameParser
    FrameParser -->|Parsed Frames| FramePublisher
    FramePublisher -->|Events| BufferManager
    BufferManager -->|UI Buffer| UISubscriber
    BufferManager -->|Chunks| StorageSubscriber
    BufferManager -->|Processing Window| ProcessingSubscriber
    StorageSubscriber -->|Finalized Chunks| ChunkedDataWriter
    ProcessingSubscriber -->|Analysis| SignalProcessor
    BufferManager -->|Session Meta| SessionManager
```
