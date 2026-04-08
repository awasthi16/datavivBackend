const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { schemaDescription } = require('../protocol/commands');

function createHttpServer(appState, logger) {
  fs.mkdirSync(path.join(appState.storageRoot, 'incoming'), { recursive: true });
  const app = express();
  const upload = multer({ dest: path.join(appState.storageRoot, 'incoming') });
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

  app.get('/schema', (_req, res) => {
    res.json(schemaDescription());
  });

  app.get('/sources', (_req, res) => {
    res.json(appState.sourceRegistry.list());
  });

  app.get('/rtc/status', (_req, res) => {
    res.json(appState.instantSwitchRtc());
  });

  app.get('/rtc/router-capabilities', (_req, res, next) => {
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

  app.post('/rtc/transports', async (_req, res, next) => {
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

  app.post('/rtc/transports/:transportId/connect', async (req, res, next) => {
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

  app.post('/rtc/consume', async (req, res, next) => {
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

  app.delete('/sources/:sourceId', async (req, res, next) => {
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

  app.get('/session/:sessionId', async (req, res, next) => {
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

  app.post('/session/:sessionId/play', async (req, res, next) => {
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

  app.post('/session/:sessionId/pause', async (req, res, next) => {
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

  app.post('/session/:sessionId/resume', async (req, res, next) => {
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

  app.post('/session/:sessionId/seek', async (req, res, next) => {
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

  app.post('/session/:sessionId/speed', async (req, res, next) => {
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

  app.post('/session/:sessionId/switch/:sourceId', async (req, res, next) => {
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

  app.post('/session/:sessionId/loop-mode', async (req, res, next) => {
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

  app.post('/session/:sessionId/sync', async (req, res, next) => {
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

  app.post('/preprocess', async (req, res, next) => {
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

  app.post('/upload-source', upload.single('video'), async (req, res, next) => {
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
