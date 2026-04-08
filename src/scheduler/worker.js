const { parentPort, workerData } = require('node:worker_threads');
const { hrtime } = require('node:process');
const { LOOP_MODES } = require('../constants');

const NS_PER_MS = 1_000_000n;

let state = {
  sourceId: workerData.sourceId,
  fps: workerData.fps,
  totalFrames: workerData.totalFrames,
  frameDurationMs: 1000 / workerData.fps,
  playbackSpeed: workerData.playbackSpeed || 1,
  loopMode: workerData.loopMode || LOOP_MODES.LOOP,
  driftSkipMs: workerData.driftSkipMs,
  frameIndex: workerData.frameIndex || 0,
  playing: false,
  basePtsMs: workerData.basePtsMs || 0,
  pausedPtsMs: workerData.basePtsMs || 0,
  startedAtNs: 0n,
  timer: null
};

function modulo(value, size) {
  return ((value % size) + size) % size;
}

function framePtsMs(frameIndex) {
  return frameIndex * state.frameDurationMs;
}

function expectedPtsMs(nowNs) {
  if (!state.playing) {
    return state.pausedPtsMs;
  }

  const elapsedMs = Number(nowNs - state.startedAtNs) / Number(NS_PER_MS);
  return state.basePtsMs + elapsedMs * state.playbackSpeed;
}

function frameIndexForPts(ptsMs) {
  const rawIndex = Math.floor(ptsMs / state.frameDurationMs);
  if (state.loopMode === LOOP_MODES.HOLD) {
    return Math.min(Math.max(rawIndex, 0), state.totalFrames - 1);
  }
  return modulo(rawIndex, state.totalFrames);
}

function scheduleNext(currentFramePts, nowNs) {
  if (!state.playing) {
    return;
  }

  const nextPts = currentFramePts + state.frameDurationMs;
  const expectedDelayMs = Math.max(
    0,
    (nextPts - expectedPtsMs(nowNs)) / Math.max(state.playbackSpeed, 0.001)
  );

  state.timer = setTimeout(tick, expectedDelayMs);
}

function emit(event) {
  parentPort.postMessage({
    sourceId: state.sourceId,
    frameIndex: state.frameIndex,
    playbackSpeed: state.playbackSpeed,
    loopMode: state.loopMode,
    playing: state.playing,
    ...event
  });
}

function tick() {
  const nowNs = hrtime.bigint();
  const targetPtsMs = expectedPtsMs(nowNs);
  let frameIndex = frameIndexForPts(targetPtsMs);
  let framePts = framePtsMs(frameIndex);
  let driftMs = targetPtsMs - framePts;
  let skippedFrames = 0;

  if (driftMs > state.driftSkipMs) {
    const catchUpIndex = frameIndexForPts(targetPtsMs + driftMs);
    skippedFrames = modulo(catchUpIndex - frameIndex, state.totalFrames);
    frameIndex = catchUpIndex;
    framePts = framePtsMs(frameIndex);
    driftMs = targetPtsMs - framePts;
  }

  state.frameIndex = frameIndex;

  emit({
    type: 'dispatch',
    videoTimestamp: framePts,
    audioTimestamp: framePts,
    driftMs: Number(driftMs.toFixed(3)),
    skippedFrames
  });

  scheduleNext(framePts, nowNs);
}

function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function handlePlay(command = {}) {
  clearTimer();
  const nowNs = hrtime.bigint();
  state.basePtsMs = command.timestamp ?? state.pausedPtsMs;
  state.startedAtNs = nowNs;
  state.playing = true;
  emit({ type: 'state' });
  setImmediate(tick);
}

function handlePause() {
  clearTimer();
  state.pausedPtsMs = expectedPtsMs(hrtime.bigint());
  state.playing = false;
  emit({ type: 'state' });
}

function handleSeek(command) {
  clearTimer();
  state.frameIndex = modulo(command.frameIndex, state.totalFrames);
  state.basePtsMs = framePtsMs(state.frameIndex);
  state.pausedPtsMs = state.basePtsMs;
  if (state.playing) {
    state.startedAtNs = hrtime.bigint();
  }
  emit({ type: 'state' });
  if (state.playing) {
    setImmediate(tick);
  }
}

function handleSetSpeed(command) {
  const nowNs = hrtime.bigint();
  const currentPts = expectedPtsMs(nowNs);
  state.basePtsMs = currentPts;
  state.pausedPtsMs = currentPts;
  state.startedAtNs = nowNs;
  state.playbackSpeed = command.speed;
  emit({ type: 'state' });
}

function handleResume() {
  handlePlay({ timestamp: state.pausedPtsMs });
}

function handleSetLoopMode(command) {
  state.loopMode = command.loopMode;
  emit({ type: 'state' });
}

function handleSync(command) {
  clearTimer();
  state.basePtsMs = command.timestamp;
  state.pausedPtsMs = command.timestamp;
  if (state.playing) {
    state.startedAtNs = hrtime.bigint();
    setImmediate(tick);
  }
  emit({ type: 'state' });
}

function handleSwitchSource(command) {
  clearTimer();
  state.sourceId = command.sourceId;
  state.fps = command.fps;
  state.totalFrames = command.totalFrames;
  state.frameDurationMs = 1000 / command.fps;
  state.loopMode = command.loopMode || state.loopMode;
  state.frameIndex = modulo(command.frameIndex || 0, state.totalFrames);
  state.basePtsMs = framePtsMs(state.frameIndex);
  state.pausedPtsMs = state.basePtsMs;
  if (state.playing) {
    state.startedAtNs = hrtime.bigint();
  }
  emit({ type: 'state' });
  if (state.playing) {
    setImmediate(tick);
  }
}

parentPort.on('message', (message) => {
  switch (message.type) {
    case 'PLAY':
      handlePlay(message);
      break;
    case 'PAUSE':
      handlePause();
      break;
    case 'SEEK':
      handleSeek(message);
      break;
    case 'SET_SPEED':
      handleSetSpeed(message);
      break;
    case 'SWITCH_SOURCE':
      handleSwitchSource(message);
      break;
    case 'RESUME':
      handleResume();
      break;
    case 'SET_LOOP_MODE':
      handleSetLoopMode(message);
      break;
    case 'SYNC':
      handleSync(message);
      break;
    default:
      emit({ type: 'error', error: `Unknown scheduler command ${message.type}` });
  }
});
