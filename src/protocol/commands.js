const { ACTION_NAMES, BINARY_SCHEMA } = require('../constants');

function assertPacketSize(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('STCP payload must be a Buffer');
  }

  if (buffer.length < BINARY_SCHEMA.totalSize) {
    throw new Error(
      `Invalid STCP packet length ${buffer.length}; expected ${BINARY_SCHEMA.totalSize}`
    );
  }
}

function parseCommand(buffer) {
  assertPacketSize(buffer);

  const command = {
    action: buffer.readUInt8(BINARY_SCHEMA.action.offset),
    streamId: buffer.readUInt8(BINARY_SCHEMA.streamId.offset),
    frameIndex: buffer.readUInt32BE(BINARY_SCHEMA.frameIndex.offset),
    timestamp: buffer.readDoubleBE(BINARY_SCHEMA.timestamp.offset),
    speed: buffer.readFloatBE(BINARY_SCHEMA.speed.offset)
  };

  return {
    ...command,
    actionName: ACTION_NAMES[command.action] || 'UNKNOWN'
  };
}

function encodeCommand(command) {
  const buffer = Buffer.alloc(BINARY_SCHEMA.totalSize);
  buffer.writeUInt8(command.action, BINARY_SCHEMA.action.offset);
  buffer.writeUInt8(command.streamId, BINARY_SCHEMA.streamId.offset);
  buffer.writeUInt32BE(command.frameIndex >>> 0, BINARY_SCHEMA.frameIndex.offset);
  buffer.writeDoubleBE(command.timestamp, BINARY_SCHEMA.timestamp.offset);
  buffer.writeFloatBE(command.speed, BINARY_SCHEMA.speed.offset);
  return buffer;
}

function schemaDescription() {
  return {
    endianness: 'big-endian',
    sizeBytes: BINARY_SCHEMA.totalSize,
    fields: BINARY_SCHEMA,
    notes: {
      timestamp: 'PTS in milliseconds. For SYNC this is the authoritative external clock value.',
      speed: 'Playback speed. For SET_LOOP_MODE use 1 for LOOP and 2 for HOLD.'
    }
  };
}

module.exports = {
  parseCommand,
  encodeCommand,
  schemaDescription
};
