class MetricsCollector {
  constructor() {
    this.snapshot = {
      activeUsers: 0,
      dispatchedFrames: 0,
      droppedFrames: 0,
      currentFps: 0,
      latestDriftMs: 0,
      bitrateKbps: 0,
      rttMs: 0,
      packetLossPct: 0,
      commandUsage: {},
      lastDispatchAt: null,
      switchingLatencyMs: null
    };
  }

  setActiveUsers(count) {
    this.snapshot.activeUsers = count;
  }

  recordCommand(actionName) {
    this.snapshot.commandUsage[actionName] = (this.snapshot.commandUsage[actionName] || 0) + 1;
  }

  recordDispatch(event, fps) {
    this.snapshot.dispatchedFrames += 1;
    this.snapshot.droppedFrames += event.skippedFrames || 0;
    this.snapshot.currentFps = fps;
    this.snapshot.latestDriftMs = event.driftMs;
    this.snapshot.lastDispatchAt = Date.now();
  }

  recordNetworkStats(stats) {
    this.snapshot.bitrateKbps = stats.bitrateKbps ?? this.snapshot.bitrateKbps;
    this.snapshot.rttMs = stats.rttMs ?? this.snapshot.rttMs;
    this.snapshot.packetLossPct = stats.packetLossPct ?? this.snapshot.packetLossPct;
  }

  recordSwitchLatency(latencyMs) {
    this.snapshot.switchingLatencyMs = latencyMs;
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      commandUsage: { ...this.snapshot.commandUsage }
    };
  }
}

module.exports = {
  MetricsCollector
};
