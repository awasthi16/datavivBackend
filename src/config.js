const path = require('node:path');
require('dotenv').config();

module.exports = {
  app: {
    port: Number.parseInt(process.env.PORT || '8080', 10),
    controlPort: Number.parseInt(process.env.CONTROL_PORT || '9000', 10),
    logLevel: process.env.LOG_LEVEL || 'info'
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
  },
  mediasoup: {
    enabled: process.env.MEDIASOUP_ENABLED !== 'false',
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
    minPort: Number.parseInt(process.env.MEDIASOUP_MIN_PORT || '40000', 10),
    maxPort: Number.parseInt(process.env.MEDIASOUP_MAX_PORT || '49999', 10),
    initialBitrate: Number.parseInt(process.env.MEDIASOUP_INITIAL_BITRATE || '1000000', 10),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {}
      }
    ]
  },
  runtime: {
    workerPath: path.join(__dirname, 'scheduler', 'worker.js'),
    driftSkipMs: 50,
    checkpointIntervalMs: 200,
    targetLatencyMs: 500
  },
  mediaTools: {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe'
  },
  storage: {
    rootDir: path.join(__dirname, '..', 'storage'),
    sourceDir: path.join(__dirname, '..', 'storage', 'sources')
  }
};
