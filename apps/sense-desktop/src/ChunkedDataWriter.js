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
    const stream = fs.createWriteStream(filename, { flags: 'w' });
    stream.write('[\n');
    return stream;
  }

  writeChunk(chunk) {
    // Accept both array and {frames, ...} object
    let frames = chunk;
    if (chunk && typeof chunk === 'object' && Array.isArray(chunk.frames)) {
      frames = chunk.frames;
    }
    if (!Array.isArray(frames) || frames.length === 0) return;
    for (const sample of frames) {
      if (this.currentChunkHasData) {
        this.currentStream.write(',\n');
      }
      this.currentStream.write(JSON.stringify(sample, null, 2));
      this.currentChunkHasData = true;
    }
    this.finalizeChunk();
  }

  finalizeChunk() {
    if (this.currentStream) {
      this.currentStream.write('\n]');
      this.currentStream.end();
    }
    this.chunkIndex++;
    this.currentStream = this._createChunkStream();
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
  }
}

module.exports = ChunkedDataWriter;
