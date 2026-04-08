const path = require('node:path');

// Load a local .env only during development if one exists.
// Render and other hosts will rely on real environment variables instead.
if (process.env.NODE_ENV !== 'production') {
  try {
    require('dotenv').config();
  } catch (_error) {
    // dotenv is optional for local development.
  }
}

module.exports = {
  app: {
    port: Number.parseInt(process.env.PORT || '8080', 10),
    controlPort: Number.parseInt(process.env.CONTROL_PORT || '9000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    adminKey: process.env.ADMIN_KEY || 'dataviv-admin'
  },
  auth: {
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
  },
  mongo: {
    uri: process.env.MONGODB_URI || '',
    dbName: process.env.MONGODB_DB || 'dataviv'
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
