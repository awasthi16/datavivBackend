const net = require('node:net');
const { ACTIONS, BINARY_SCHEMA, LOOP_MODES } = require('../constants');
const { parseCommand } = require('../protocol/commands');

class StcpServer {
  constructor({ port }, logger, onCommand) {
    this.port = port;
    this.logger = logger;
    this.onCommand = onCommand;
    this.server = null;
  }

  start() {
    this.server = net.createServer((socket) => {
      this.logger.info('STCP client connected', {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort
      });

      let pending = Buffer.alloc(0);
      socket.on('data', async (buffer) => {
        pending = Buffer.concat([pending, buffer]);

        while (pending.length >= BINARY_SCHEMA.totalSize) {
          const packet = pending.subarray(0, BINARY_SCHEMA.totalSize);
          pending = pending.subarray(BINARY_SCHEMA.totalSize);

          try {
            const command = parseCommand(packet);
            await this.onCommand(command);
            socket.write(
              JSON.stringify({
                ok: true,
                action: command.actionName,
                frameIndex: command.frameIndex
              })
            );
          } catch (error) {
            this.logger.error('Failed to handle STCP command', { error: error.message });
            socket.write(JSON.stringify({ ok: false, error: error.message }));
          }
        }
      });
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        this.logger.info('STCP control server listening', { port: this.port });
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function toSchedulerCommand(command, source) {
  switch (command.action) {
    case ACTIONS.PLAY:
      return { type: 'PLAY', timestamp: command.timestamp };
    case ACTIONS.PAUSE:
      return { type: 'PAUSE' };
    case ACTIONS.SEEK:
      return { type: 'SEEK', frameIndex: command.frameIndex };
    case ACTIONS.SWITCH_SOURCE:
      return {
        type: 'SWITCH_SOURCE',
        sourceId: source.sourceId,
        fps: source.fps,
        totalFrames: source.totalFrames,
        frameIndex: command.frameIndex
      };
    case ACTIONS.SET_SPEED:
      return { type: 'SET_SPEED', speed: command.speed };
    case ACTIONS.RESUME:
      return { type: 'RESUME' };
    case ACTIONS.SET_LOOP_MODE:
      return {
        type: 'SET_LOOP_MODE',
        loopMode:
          Math.round(command.speed) === LOOP_MODES.HOLD ? LOOP_MODES.HOLD : LOOP_MODES.LOOP
      };
    case ACTIONS.SYNC:
      return { type: 'SYNC', timestamp: command.timestamp };
    default:
      throw new Error(`Unsupported action ${command.action}`);
  }
}

module.exports = {
  StcpServer,
  toSchedulerCommand
};
