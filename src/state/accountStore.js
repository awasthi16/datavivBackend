const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch (_error) {
  MongoClient = null;
}

class AccountStore {
  constructor({ mongoUrl, dbName, fallbackDir }, logger) {
    this.mongoUrl = mongoUrl;
    this.dbName = dbName;
    this.fallbackDir = fallbackDir;
    this.logger = logger;
    this.mode = 'file';
    this.client = null;
    this.sessionsCollection = null;
    this.viewerStatesCollection = null;
    this.filePaths = {
      sessions: path.join(fallbackDir, 'auth-sessions.json'),
      viewerStates: path.join(fallbackDir, 'viewer-states.json')
    };
  }

  async connect() {
    if (this.mongoUrl && MongoClient) {
      try {
        this.client = new MongoClient(this.mongoUrl, {
          maxPoolSize: 5
        });
        await this.client.connect();
        const db = this.client.db(this.dbName);
        this.sessionsCollection = db.collection('auth_sessions');
        this.viewerStatesCollection = db.collection('viewer_states');
        await Promise.all([
          this.sessionsCollection.createIndex({ token: 1 }, { unique: true }),
          this.sessionsCollection.createIndex({ role: 1 }),
          this.viewerStatesCollection.createIndex({ token: 1 }, { unique: true })
        ]);
        this.mode = 'mongo';
        this.logger.info('Connected to MongoDB for auth and viewer sessions', {
          dbName: this.dbName
        });
        return;
      } catch (error) {
        this.logger.warn('MongoDB unavailable, falling back to local auth store', {
          error: error.message
        });
      }
    } else if (this.mongoUrl && !MongoClient) {
      this.logger.warn('MongoDB driver not installed, falling back to local auth store');
    }

    this.mode = 'file';
    await fs.mkdir(this.fallbackDir, { recursive: true });
    await this.ensureFile(this.filePaths.sessions, { sessions: {} });
    await this.ensureFile(this.filePaths.viewerStates, { states: {} });
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  async ensureFile(filePath, seed) {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, JSON.stringify(seed, null, 2), 'utf8');
    }
  }

  async readJson(filePath, seed) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content || JSON.stringify(seed));
    } catch {
      return seed;
    }
  }

  async writeJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  nowIso() {
    return new Date().toISOString();
  }

  createBaseSession({ role, username, displayName }) {
    return {
      token: randomUUID(),
      role,
      username: username || null,
      displayName: displayName || null,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso()
    };
  }

  async createSession({ role, username, displayName }) {
    const session = this.createBaseSession({ role, username, displayName });

    if (this.mode === 'mongo') {
      await this.sessionsCollection.insertOne(session);
      return session;
    }

    const data = await this.readJson(this.filePaths.sessions, { sessions: {} });
    data.sessions[session.token] = session;
    await this.writeJson(this.filePaths.sessions, data);
    return session;
  }

  async getSession(token) {
    if (!token) {
      return null;
    }

    if (this.mode === 'mongo') {
      return this.sessionsCollection.findOne({ token }, { projection: { _id: 0 } });
    }

    const data = await this.readJson(this.filePaths.sessions, { sessions: {} });
    return data.sessions[token] || null;
  }

  async revokeSession(token) {
    if (!token) {
      return;
    }

    if (this.mode === 'mongo') {
      await Promise.all([
        this.sessionsCollection.deleteOne({ token }),
        this.viewerStatesCollection.deleteOne({ token })
      ]);
      return;
    }

    const sessions = await this.readJson(this.filePaths.sessions, { sessions: {} });
    const viewerStates = await this.readJson(this.filePaths.viewerStates, { states: {} });
    delete sessions.sessions[token];
    delete viewerStates.states[token];
    await Promise.all([
      this.writeJson(this.filePaths.sessions, sessions),
      this.writeJson(this.filePaths.viewerStates, viewerStates)
    ]);
  }

  async getViewerState(token) {
    if (!token) {
      return null;
    }

    if (this.mode === 'mongo') {
      return this.viewerStatesCollection.findOne({ token }, { projection: { _id: 0 } });
    }

    const data = await this.readJson(this.filePaths.viewerStates, { states: {} });
    return data.states[token] || null;
  }

  async saveViewerState(token, state) {
    const payload = {
      token,
      sessionId: state.sessionId || token,
      sourceId: Number.parseInt(state.sourceId, 10),
      frameIndex: Number.parseInt(state.frameIndex, 10),
      timestamp: Number.parseFloat(state.timestamp || '0'),
      playbackSpeed: Number.parseFloat(state.playbackSpeed || '1'),
      loopMode: Number.parseInt(state.loopMode || '1', 10),
      playing: Boolean(state.playing),
      updatedAt: this.nowIso()
    };

    if (this.mode === 'mongo') {
      await this.viewerStatesCollection.updateOne(
        { token },
        { $set: payload },
        { upsert: true }
      );
      return payload;
    }

    const data = await this.readJson(this.filePaths.viewerStates, { states: {} });
    data.states[token] = payload;
    await this.writeJson(this.filePaths.viewerStates, data);
    return payload;
  }
}

module.exports = {
  AccountStore
};
