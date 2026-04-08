const fs = require('node:fs/promises');
const path = require('node:path');
const Redis = require('ioredis');

class SessionStore {
  constructor({ url, checkpointIntervalMs, fallbackDir }, logger) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1
    });
    this.logger = logger;
    this.checkpointIntervalMs = checkpointIntervalMs;
    this.fallbackPath = path.join(fallbackDir, 'session-store.json');
    this.mode = 'redis';
    this.redis.on('error', (error) => {
      if (this.mode === 'redis') {
        this.logger.warn('Redis client error', { error: error.message });
      }
    });
  }

  async connect() {
    try {
      await this.redis.connect();
      this.logger.info('Connected to Redis');
    } catch (error) {
      this.mode = 'file';
      this.logger.warn('Redis unavailable, falling back to local session store', {
        error: error.message,
        fallbackPath: this.fallbackPath
      });
      await fs.mkdir(path.dirname(this.fallbackPath), { recursive: true });
      await fs.writeFile(this.fallbackPath, '{}', { encoding: 'utf8', flag: 'a' }).catch(() => {});
    }
  }

  async disconnect() {
    if (this.mode === 'redis') {
      await this.redis.quit();
    }
  }

  key(sessionId) {
    return `session:${sessionId}`;
  }

  async save(sessionId, state) {
    const payload = {
      sessionId,
      sourceId: String(state.sourceId),
      frameIndex: String(state.frameIndex),
      timestamp: String(state.timestamp),
      playbackSpeed: String(state.playbackSpeed),
      loopMode: String(state.loopMode),
      playing: String(state.playing),
      updatedAt: String(Date.now())
    };

    if (this.mode === 'redis') {
      await this.redis.hset(this.key(sessionId), payload);
      return;
    }

    const data = await this.readFallback();
    data[sessionId] = payload;
    await fs.writeFile(this.fallbackPath, JSON.stringify(data, null, 2), 'utf8');
  }

  async load(sessionId) {
    const state =
      this.mode === 'redis'
        ? await this.redis.hgetall(this.key(sessionId))
        : (await this.readFallback())[sessionId];

    if (!state || Object.keys(state).length === 0) {
      return null;
    }

    return {
      sessionId,
      sourceId: Number.parseInt(state.sourceId, 10),
      frameIndex: Number.parseInt(state.frameIndex, 10),
      timestamp: Number.parseFloat(state.timestamp || '0'),
      playbackSpeed: Number.parseFloat(state.playbackSpeed),
      loopMode: Number.parseInt(state.loopMode || '1', 10),
      playing: state.playing === 'true'
    };
  }

  async readFallback() {
    try {
      const content = await fs.readFile(this.fallbackPath, 'utf8');
      return JSON.parse(content || '{}');
    } catch (_error) {
      return {};
    }
  }
}

module.exports = {
  SessionStore
};
