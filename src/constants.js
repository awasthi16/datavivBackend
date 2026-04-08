const ACTIONS = Object.freeze({
  PLAY: 1,
  PAUSE: 2,
  SEEK: 3,
  SWITCH_SOURCE: 4,
  SET_SPEED: 5,
  RESUME: 6,
  SET_LOOP_MODE: 7,
  SYNC: 8
});

const LOOP_MODES = Object.freeze({
  LOOP: 1,
  HOLD: 2
});

const ACTION_NAMES = Object.freeze(
  Object.entries(ACTIONS).reduce((acc, [key, value]) => {
    acc[value] = key;
    return acc;
  }, {})
);

const BINARY_SCHEMA = Object.freeze({
  action: { offset: 0, size: 1, type: 'uint8' },
  streamId: { offset: 1, size: 1, type: 'uint8' },
  frameIndex: { offset: 2, size: 4, type: 'uint32' },
  timestamp: { offset: 6, size: 8, type: 'float64' },
  speed: { offset: 14, size: 4, type: 'float32' },
  totalSize: 18
});

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  BINARY_SCHEMA,
  LOOP_MODES
};
