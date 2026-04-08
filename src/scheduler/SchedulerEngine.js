const { Worker } = require('node:worker_threads');

class SchedulerEngine {
  constructor({ workerPath, driftSkipMs }, logger) {
    this.workerPath = workerPath;
    this.driftSkipMs = driftSkipMs;
    this.logger = logger;
    this.worker = null;
  }

  start(source, sessionState, onDispatch) {
    this.worker = new Worker(this.workerPath, {
      workerData: {
        sourceId: source.sourceId,
        fps: source.fps,
        totalFrames: source.totalFrames,
        playbackSpeed: sessionState.playbackSpeed,
        loopMode: sessionState.loopMode,
        frameIndex: sessionState.frameIndex,
        basePtsMs: sessionState.frameIndex * source.frameDurationMs,
        driftSkipMs: this.driftSkipMs
      }
    });

    this.worker.on('message', onDispatch);
    this.worker.on('error', (error) => {
      this.logger.error('Scheduler worker error', { error: error.message });
    });
    this.worker.on('exit', (code) => {
      this.logger.warn('Scheduler worker exited', { code });
    });
  }

  command(message) {
    if (!this.worker) {
      throw new Error('Scheduler worker not started');
    }

    this.worker.postMessage(message);
  }

  async stop() {
    if (!this.worker) {
      return;
    }
    await this.worker.terminate();
    this.worker = null;
  }
}

module.exports = {
  SchedulerEngine
};
