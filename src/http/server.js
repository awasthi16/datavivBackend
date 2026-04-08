const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { LOOP_MODES } = require('../constants');
const { schemaDescription } = require('../protocol/commands');

function createHttpServer(appState, logger) {
  fs.mkdirSync(path.join(appState.storageRoot, 'incoming'), { recursive: true });
  const app = express();
  const upload = multer({ dest: path.join(appState.storageRoot, 'incoming') });

  function getAuthToken(req) {
    const header = req.headers.authorization || '';
    if (header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }

    return req.query.token || req.body?.token || null;
  }

  async function loadSession(req) {
    if (req.session) {
      return req.session;
    }

    const token = getAuthToken(req);
    if (!token) {
      return null;
    }

    const session = await appState.accountStore.getSession(token);
    if (session) {
      req.session = session;
    }

    return session;
  }

  async function requireAuth(req, res, next) {
    try {
      const session = await loadSession(req);
      if (!session) {
        res.status(401).json({ ok: false, error: 'Authentication required' });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  }

  async function requireAdmin(req, res, next) {
    try {
      const session = await loadSession(req);
      if (!session) {
        res.status(401).json({ ok: false, error: 'Authentication required' });
        return;
      }

      if (session.role !== 'admin') {
        res.status(403).json({ ok: false, error: 'Admin access required' });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  }

  async function ensureViewerSession(req) {
    const authSession = await loadSession(req);
    if (!authSession || authSession.role === 'admin') {
      const error = new Error('Viewer authentication required');
      error.statusCode = 401;
      throw error;
    }

    let viewerSession = await appState.accountStore.getViewerState(authSession.token);

    if (!viewerSession) {
      viewerSession = await appState.accountStore.saveViewerState(authSession.token, {
        sessionId: authSession.token,
        sourceId: appState.activeSource.sourceId,
        frameIndex: 0,
        timestamp: 0,
        playbackSpeed: 1,
        loopMode: LOOP_MODES.LOOP,
        playing: false
      });
      return viewerSession;
    }

    if (viewerSession.sourceId !== appState.activeSource.sourceId) {
      viewerSession = await appState.accountStore.saveViewerState(authSession.token, {
        ...viewerSession,
        sourceId: appState.activeSource.sourceId,
        frameIndex: 0,
        timestamp: 0,
        playing: false
      });
    }

    return viewerSession;
  }

  async function updateViewerSession(req, patch) {
    const authSession = await loadSession(req);
    if (!authSession || authSession.role === 'admin') {
      const error = new Error('Viewer authentication required');
      error.statusCode = 401;
      throw error;
    }

    const current = await ensureViewerSession(req);
    const updated = await appState.accountStore.saveViewerState(authSession.token, {
      ...current,
      ...patch,
      sourceId: appState.activeSource.sourceId
    });
    return updated;
  }

  app.use((req, res, next) => {
    const origin = appState.corsOrigin;

    if (origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (req.headers.origin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json());
  app.use('/storage', express.static(appState.storageRoot));
  app.use(express.static(appState.publicRoot));

  function getSourceOrThrow(sourceId) {
    const source = appState.sourceRegistry.find(sourceId);

    if (!source) {
      const error = new Error(`Unknown sourceId: ${sourceId}`);
      error.statusCode = 404;
      throw error;
    }

    return source;
  }

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      latencyTargetMs: appState.targetLatencyMs,
      activeSourceId: appState.activeSource?.sourceId ?? null,
      stateStore: appState.sessionStore.mode,
      mediasoupEnabled: appState.instantSwitch?.mediasoupEnabled ?? undefined
    });
  });

  app.post('/auth/login', async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');

      if (
        username !== appState.auth.adminUsername ||
        password !== appState.auth.adminPassword
      ) {
        res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
        return;
      }

      const session = await appState.accountStore.createSession({
        role: 'admin',
        username,
        displayName: 'Administrator'
      });

      res.json({
        ok: true,
        token: session.token,
        user: session
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/viewer', async (req, res, next) => {
    try {
      const displayName = String(req.body.displayName || 'Viewer').trim() || 'Viewer';
      const session = await appState.accountStore.createSession({
        role: 'viewer',
        displayName
      });

      const viewerSession = await appState.accountStore.saveViewerState(session.token, {
        sessionId: session.token,
        sourceId: appState.activeSource.sourceId,
        frameIndex: 0,
        timestamp: 0,
        playbackSpeed: 1,
        loopMode: LOOP_MODES.LOOP,
        playing: false
      });

      res.json({
        ok: true,
        token: session.token,
        user: session,
        viewerSession
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth/me', async (req, res, next) => {
    try {
      const session = await loadSession(req);

      if (!session) {
        res.status(401).json({ ok: false, error: 'Not authenticated' });
        return;
      }

      const response = { ok: true, user: session };
      if (session.role === 'viewer') {
        response.viewerSession = await ensureViewerSession(req);
      }

      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/logout', async (req, res, next) => {
    try {
      const session = await loadSession(req);
      if (!session) {
        res.json({ ok: true });
        return;
      }

      await appState.accountStore.revokeSession(session.token);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/schema', (_req, res) => {
    res.json(schemaDescription());
  });

  app.get('/sources', (_req, res) => {
    res.json(appState.sourceRegistry.list());
  });

  app.get('/rtc/status', (_req, res) => {
    res.json(appState.instantSwitchRtc());
  });

  app.get('/rtc/router-capabilities', requireAuth, (_req, res, next) => {
    try {
      const caps = appState.mediasoupManager.getRouterRtpCapabilities();
      if (!caps) {
        const error = new Error('Mediasoup router is not available');
        error.statusCode = 503;
        throw error;
      }

      res.json(caps);
    } catch (error) {
      next(error);
    }
  });

  app.post('/rtc/transports', requireAuth, async (_req, res, next) => {
    try {
      const transport = await appState.mediasoupManager.createWebRtcTransport();
      res.json({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/rtc/transports/:transportId/connect', requireAuth, async (req, res, next) => {
    try {
      await appState.mediasoupManager.connectTransport(
        req.params.transportId,
        req.body.dtlsParameters
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/rtc/consume', requireAuth, async (req, res, next) => {
    try {
      const consumer = await appState.mediasoupManager.consume({
        transportId: req.body.transportId,
        rtpCapabilities: req.body.rtpCapabilities,
        kind: req.body.kind
      });

      res.json({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/sources/:sourceId/manifest', (req, res) => {
    const source = getSourceOrThrow(Number.parseInt(req.params.sourceId, 10));
    res.json(source);
  });

  app.delete('/sources/:sourceId', requireAdmin, async (req, res, next) => {
    try {
      const sourceId = Number.parseInt(req.params.sourceId, 10);
      const deletingActiveSource = appState.activeSource?.sourceId === sourceId;

      await appState.sourceRegistry.delete(sourceId);

      if (deletingActiveSource) {
        const fallbackSource = appState.sourceRegistry.get(1);
        appState.activeSource = fallbackSource;
        appState.session.sourceId = fallbackSource.sourceId;
        appState.session.frameIndex = 0;
        appState.session.timestamp = 0;
        appState.session.playing = false;

        await appState.sessionStore.save(req.params.sessionId || 'default', {
          sourceId: fallbackSource.sourceId,
          frameIndex: 0,
          timestamp: 0,
          playbackSpeed: appState.session.playbackSpeed,
          loopMode: appState.session.loopMode,
          playing: false
        });
      }

      const payload = `data: ${JSON.stringify(appState.getDashboardState())}\n\n`;
      for (const client of appState.sseClients) {
        client.write(payload);
      }

      res.json({
        ok: true,
        deletedSourceId: sourceId,
        activeSourceId: appState.activeSource?.sourceId ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/session/:sessionId', requireAdmin, async (req, res, next) => {
    try {
      const session = await appState.sessionStore.load(req.params.sessionId);
      res.json(session || { sessionId: req.params.sessionId, missing: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/metrics', (_req, res) => {
    res.json(appState.metrics.getSnapshot());
  });

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    appState.sseClients.add(res);
    appState.metrics.setActiveUsers(appState.sseClients.size);
    res.write(`data: ${JSON.stringify(appState.getDashboardState())}\n\n`);

    req.on('close', () => {
      appState.sseClients.delete(res);
      appState.metrics.setActiveUsers(appState.sseClients.size);
    });
  });

  app.post('/session/:sessionId/play', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'PLAY',
        action: 1,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: req.body.timestamp ?? 0,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/pause', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'PAUSE',
        action: 2,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: appState.session.timestamp,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/resume', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'RESUME',
        action: 6,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: appState.session.timestamp,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/seek', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'SEEK',
        action: 3,
        streamId: appState.activeSource.sourceId,
        frameIndex: req.body.frameIndex ?? 0,
        timestamp: req.body.timestamp ?? 0,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/speed', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'SET_SPEED',
        action: 5,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: appState.session.timestamp,
        speed: req.body.speed ?? 1
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/switch/:sourceId', requireAdmin, async (req, res, next) => {
    try {
      getSourceOrThrow(Number.parseInt(req.params.sourceId, 10));
      await appState.handleControl({
        actionName: 'SWITCH_SOURCE',
        action: 4,
        streamId: Number.parseInt(req.params.sourceId, 10),
        frameIndex: req.body.frameIndex ?? 0,
        timestamp: 0,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true, activeSource: appState.activeSource.sourceId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/loop-mode', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'SET_LOOP_MODE',
        action: 7,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: appState.session.timestamp,
        speed: req.body.loopMode ?? 1
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/session/:sessionId/sync', requireAdmin, async (req, res, next) => {
    try {
      await appState.handleControl({
        actionName: 'SYNC',
        action: 8,
        streamId: appState.activeSource.sourceId,
        frameIndex: appState.session.frameIndex,
        timestamp: req.body.timestamp ?? appState.session.timestamp,
        speed: appState.session.playbackSpeed
      });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/viewer/session', requireAuth, async (req, res, next) => {
    try {
      const session = await ensureViewerSession(req);
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/play', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, {
        playing: true,
        timestamp: Number.parseFloat(req.body.timestamp ?? 0)
      });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/pause', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, { playing: false });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/resume', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, { playing: true });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/seek', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, {
        frameIndex: Number.parseInt(req.body.frameIndex ?? 0, 10),
        timestamp: Number.parseFloat(req.body.timestamp ?? 0)
      });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/speed', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, {
        playbackSpeed: Number.parseFloat(req.body.speed ?? 1)
      });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/loop-mode', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, {
        loopMode: Number.parseInt(req.body.loopMode ?? LOOP_MODES.LOOP, 10)
      });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/viewer/session/sync', requireAuth, async (req, res, next) => {
    try {
      const session = await updateViewerSession(req, {
        timestamp: Number.parseFloat(req.body.timestamp ?? 0)
      });
      res.json({ ok: true, session });
    } catch (error) {
      next(error);
    }
  });

  app.post('/preprocess', requireAdmin, async (req, res, next) => {
    try {
      const sourceId = Number.parseInt(req.body.sourceId, 10);
      const manifest = await appState.preprocessor.preprocess({
        inputPath: req.body.inputPath,
        sourceId,
        name: req.body.name || `Source ${sourceId}`
      });
      await appState.sourceRegistry.loadFromDisk();
      res.json({ ok: true, manifest });
    } catch (error) {
      next(error);
    }
  });

  app.post('/upload-source', requireAdmin, upload.single('video'), async (req, res, next) => {
    try {
      if (!req.file) {
        const error = new Error('No video file uploaded');
        error.statusCode = 400;
        throw error;
      }

      const sourceId = Number.parseInt(req.body.sourceId || Date.now().toString(), 10);
      const uploadedPath = await appState.preprocessor.persistUploadedFile(req.file);
      const manifest = await appState.preprocessor.preprocess({
        inputPath: uploadedPath,
        sourceId,
        name: req.body.name || req.file.originalname || `Source ${sourceId}`
      });

      await appState.sourceRegistry.loadFromDisk();
      res.json({ ok: true, manifest });
    } catch (error) {
      next(error);
    }
  });

  app.get('*', (req, res, next) => {
    if (!req.accepts('html')) {
      next();
      return;
    }

    const indexPath = path.join(appState.publicRoot, 'index.html');

    if (!fs.existsSync(indexPath)) {
      next();
      return;
    }

    res.sendFile(indexPath);
  });

  app.use((error, _req, res, _next) => {
    logger.error('HTTP error', { error: error.message });
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  });

  return app;
}

module.exports = {
  createHttpServer
};
