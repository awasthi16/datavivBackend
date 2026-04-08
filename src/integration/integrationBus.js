class IntegrationBus {
  constructor(logger) {
    this.logger = logger;
    this.frameHandlers = new Set();
    this.audioHandlers = new Set();
  }

  onFrame(handler) {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onAudio(handler) {
    this.audioHandlers.add(handler);
    return () => this.audioHandlers.delete(handler);
  }

  emitFrame(frame, timestamp) {
    for (const handler of this.frameHandlers) {
      Promise.resolve(handler(frame, timestamp)).catch((error) => {
        this.logger.error('Frame handler failed', { error: error.message });
      });
    }
  }

  emitAudio(audioChunk, timestamp) {
    for (const handler of this.audioHandlers) {
      Promise.resolve(handler(audioChunk, timestamp)).catch((error) => {
        this.logger.error('Audio handler failed', { error: error.message });
      });
    }
  }
}

module.exports = {
  IntegrationBus
};
