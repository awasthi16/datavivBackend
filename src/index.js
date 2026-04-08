const http = require('node:http');
const path = require('node:path');
const config = require('./config');
const { LOOP_MODES } = require('./constants');
const { createLogger } = require('./utils/logger');
const { SourceRegistry } = require('./media/sourceRegistry');
const { getFramePair } = require('./media/frameTimeline');
const { MediaPreprocessor } = require('./media/preprocessor');
const { SessionStore } = require('./state/sessionStore');
const { AccountStore } = require('./state/accountStore');
const { SchedulerEngine } = require('./scheduler/SchedulerEngine');
const { MediasoupManager } = require('./rtc/mediasoupManager');
const { StcpServer, toSchedulerCommand } = require('./control/stcpServer');
const { createHttpServer } = require('./http/server');
const { MetricsCollector } = require('./monitoring/metricsCollector');
const { IntegrationBus } = require('./integration/integrationBus');

async function main() {
  const logger = createLogger(config.app.logLevel);
  const sourceRegistry = new SourceRegistry(logger, config.storage.sourceDir);
  await sourceRegistry.loadFromDisk();
  sourceRegistry.registerSyntheticSources();

  const preprocessor = new MediaPreprocessor(
    {
      sourceDir: config.storage.sourceDir,
      ffmpegPath: config.mediaTools.ffmpegPath,
      ffprobePath: config.mediaTools.ffprobePath
    },
    logger
  );
  const metrics = new MetricsCollector();
  const integrationBus = new IntegrationBus(logger);

  const sessionStore = new SessionStore(
    {
      url: config.redis.url,
      checkpointIntervalMs: config.runtime.checkpointIntervalMs,
      fallbackDir: config.storage.rootDir
    },
    logger
  );
  await sessionStore.connect();

  const accountStore = new AccountStore(
    {
      mongoUrl: config.mongo.uri,
      dbName: config.mongo.dbName,
      fallbackDir: config.storage.rootDir
    },
    logger
  );
  await accountStore.connect();

  const sessionId = 'default';
  const restoredState =
    (await sessionStore.load(sessionId)) || {
      sessionId,
      sourceId: 1,
      frameIndex: 0,
      timestamp: 0,
      playbackSpeed: 1,
      loopMode: LOOP_MODES.LOOP,
      playing: false
    };

  const mediasoupManager = new MediasoupManager(config.mediasoup, logger);
  await mediasoupManager.start();

  const appState = {
    targetLatencyMs: config.runtime.targetLatencyMs,
    corsOrigin: config.app.corsOrigin,
    auth: config.auth,
    storageRoot: config.storage.rootDir,
    publicRoot: path.join(__dirname, '..', '..', 'frontend', 'dist'),
    preprocessor,
    accountStore,
    metrics,
    integrationBus,
    sseClients: new Set(),
    sessionStore,
    sourceRegistry,
    mediasoupManager,
    session: restoredState,
    activeSource: sourceRegistry.get(restoredState.sourceId),
    instantSwitch: {
      ...mediasoupManager.describeInstantSwitch(),
      mediasoupEnabled: mediasoupManager.enabled
    },
    instantSwitchRtc() {
      return mediasoupManager.describeRtcReadiness();
    },
    getDashboardState() {
      return {
        session: appState.session,
        activeSource: {
          sourceId: appState.activeSource.sourceId,
          name: appState.activeSource.name,
          fps: appState.activeSource.fps,
          totalFrames: appState.activeSource.totalFrames,
          videoUrl: appState.activeSource.videoUrl || null,
          posterUrl: appState.activeSource.posterUrl || null
        },
        metrics: appState.metrics.getSnapshot(),
        sources: appState.sourceRegistry.list(),
        instantSwitch: appState.instantSwitch,
        rtc: appState.instantSwitchRtc()
      };
    }
  };

  const scheduler = new SchedulerEngine(
    {
      workerPath: config.runtime.workerPath,
      driftSkipMs: config.runtime.driftSkipMs
    },
    logger
  );

  function broadcastDashboard() {
    const payload = `data: ${JSON.stringify(appState.getDashboardState())}\n\n`;
    for (const client of appState.sseClients) {
      client.write(payload);
    }
  }

  scheduler.start(appState.activeSource, restoredState, async (event) => {
    if (event.type !== 'dispatch') {
      return;
    }

    appState.session.frameIndex = event.frameIndex;
    appState.session.timestamp = event.videoTimestamp;
    appState.session.playbackSpeed = event.playbackSpeed;
    appState.session.loopMode = event.loopMode;
    appState.session.playing = event.playing;
    metrics.recordDispatch(event, appState.activeSource.fps);

    const pair = getFramePair(appState.activeSource, event.frameIndex);
    integrationBus.emitFrame(pair.video, event.videoTimestamp);
    integrationBus.emitAudio(pair.audio, event.audioTimestamp);

    logger.debug('Dispatching synchronized frame/audio pair', {
      sourceId: appState.activeSource.sourceId,
      frameIndex: event.frameIndex,
      driftMs: event.driftMs,
      skippedFrames: event.skippedFrames,
      videoPayload: pair.video.payloadRef,
      audioPayload: pair.audio.payloadRef
    });

    await sessionStore.save(sessionId, {
      sourceId: appState.activeSource.sourceId,
      frameIndex: event.frameIndex,
      timestamp: event.videoTimestamp,
      playbackSpeed: event.playbackSpeed,
      loopMode: event.loopMode,
      playing: event.playing
    });

    broadcastDashboard();
  });

  appState.handleControl = async (command) => {
    logger.info('Received control command', command);
    metrics.recordCommand(command.actionName);

    const source =
      command.actionName === 'SWITCH_SOURCE'
        ? sourceRegistry.get(command.streamId)
        : appState.activeSource;

    if (command.actionName === 'SWITCH_SOURCE') {
      appState.activeSource = source;
      appState.session.sourceId = source.sourceId;

      const latencyMs = await mediasoupManager.switchProducerTracks({
        nextVideoTrack: null,
        nextAudioTrack: null,
        source
      });
      metrics.recordSwitchLatency(latencyMs);
    }

    scheduler.command(toSchedulerCommand(command, source));

    if (command.actionName === 'SET_SPEED') {
      appState.session.playbackSpeed = command.speed;
    }

    if (command.actionName === 'PLAY' || command.actionName === 'RESUME') {
      appState.session.playing = true;
    } else if (command.actionName === 'PAUSE') {
      appState.session.playing = false;
    } else if (command.actionName === 'SEEK') {
      appState.session.frameIndex = command.frameIndex;
      appState.session.timestamp = command.timestamp;
    } else if (command.actionName === 'SWITCH_SOURCE') {
      appState.session.frameIndex = command.frameIndex;
      appState.session.timestamp = command.timestamp;
    } else if (command.actionName === 'SET_LOOP_MODE') {
      appState.session.loopMode = Math.round(command.speed);
    } else if (command.actionName === 'SYNC') {
      appState.session.timestamp = command.timestamp;
    }

    await sessionStore.save(sessionId, {
      sourceId: appState.activeSource.sourceId,
      frameIndex: appState.session.frameIndex,
      timestamp: appState.session.timestamp,
      playbackSpeed: appState.session.playbackSpeed,
      loopMode: appState.session.loopMode,
      playing: appState.session.playing
    });

    broadcastDashboard();
  };

  integrationBus.onFrame(async () => {
    metrics.recordNetworkStats({
      bitrateKbps: Math.round(appState.activeSource.fps * 48),
      rttMs: 22,
      packetLossPct: 0.1
    });
  });

  const stcpServer = new StcpServer({ port: config.app.controlPort }, logger, appState.handleControl);
  await stcpServer.start();

  if (appState.activeSource?.storedVideoPath) {
    const latencyMs = await mediasoupManager.startRtpSource(appState.activeSource);
    metrics.recordSwitchLatency(latencyMs);
  }

  const httpApp = createHttpServer(appState, logger);
  const httpServer = http.createServer(httpApp);
  httpServer.listen(config.app.port, () => {
    logger.info('HTTP server listening', { port: config.app.port });
    logger.info('Instant source switching strategy', mediasoupManager.describeInstantSwitch());
  });

  const shutdown = async () => {
    logger.info('Shutting down');
    await scheduler.stop();
    await stcpServer.stop();
    await sessionStore.disconnect();
    await accountStore.disconnect();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
