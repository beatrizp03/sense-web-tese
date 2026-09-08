const fs = require('fs');
const path = require('path');

class ChunkedDataWriter {
  constructor(options) {
    this.outputDir = options.outputDir || path.join(__dirname, 'data');
    this.baseFilename = options.baseFilename || 'samples';
    this.chunkIndex = 0;
    this.currentStream = this._createChunkStream();
    this.currentChunkHasData = false;
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  _createChunkStream() {
    const filename = path.join(
      this.outputDir,
      `${this.baseFilename}_chunk${this.chunkIndex}.json`
    );
    console.log(`[MAIN] Creating chunk file: ${filename}`);
    const stream = fs.createWriteStream(filename, { flags: 'w' });
    stream.write('[\n');
    return stream;
  }

  writeChunk(chunk, onFinish) {
    let frames = chunk;
    if (chunk && typeof chunk === 'object' && Array.isArray(chunk.frames)) {
      frames = chunk.frames;
    }
    if (!Array.isArray(frames) || frames.length === 0) return;
    if (!this.currentStream) {
      this.currentStream = this._createChunkStream();
    }
    for (const sample of frames) {
      if (this.currentChunkHasData) {
        this.currentStream.write(',\n');
      }
      this.currentStream.write(JSON.stringify(sample, null, 2));
      this.currentChunkHasData = true;
    }
    this.lastFilename = this.currentStream.path;
    console.log(`[MAIN] Wrote chunk with ${frames.length} frames to ${this.currentStream.path}`);
    this.finalizeChunk(onFinish, frames.length);
  }

  getLastFilename() {
    return this.lastFilename;
  }
  
  finalizeChunk(onFinish, frameCount) {
    if (this.currentStream) {
      this.currentStream.write('\n]');
      this.currentStream.end();
      if (typeof onFinish === 'function') {
        this.currentStream.once('finish', () => {
          onFinish(this.lastFilename, frameCount);
        });
      }
    }
    this.chunkIndex++;
    console.log(`[MAIN] Finalized chunk ${this.chunkIndex - 1}`);
    this.currentStream = null;
    this.currentChunkHasData = false;
  }

  finalizeSession() {
    if (this.currentStream) {
      this.currentStream.write('\n]');
      this.currentStream.end();
    }
    this.deleteEmptyChunks();
  }

  deleteEmptyChunks() {
    try {
      const files = fs.readdirSync(this.outputDir);
      files.forEach(file => {
        if (file.startsWith(this.baseFilename + '_chunk') && file.endsWith('.json')) {
          const filePath = path.join(this.outputDir, file);
          const stats = fs.statSync(filePath);
          if (stats.size <= 3) {
            fs.unlinkSync(filePath);
          }
        }
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.warn(`[ChunkedDataWriter] No folder in directory: ${this.outputDir} (might have been deleted)`);
      } else {
        console.error('[ChunkedDataWriter] Error in deleteEmptyChunks:', err);
      }
    }
  }
}

module.exports = ChunkedDataWriter;
