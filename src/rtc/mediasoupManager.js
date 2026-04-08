const { spawn } = require('node:child_process');

class MediasoupManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = config.enabled;
    this.worker = null;
    this.router = null;
    this.videoProducer = null;
    this.audioProducer = null;
    this.videoConsumers = new Set();
    this.transports = new Map();
    this.rtpSender = null;
    this.senderResources = null;
    this.currentSourceId = null;
    this.lastSenderError = null;
    this.senderProfile = {
      videoSsrc: 22222222,
      audioSsrc: 11111111
    };
  }

  async start() {
    if (!this.enabled) {
      this.logger.warn('Mediasoup disabled by configuration');
      return;
    }

    try {
      const mediasoup = require('mediasoup');
      this.worker = await mediasoup.createWorker({
        rtcMinPort: this.config.minPort,
        rtcMaxPort: this.config.maxPort,
        logLevel: 'warn',
        logTags: ['ice', 'dtls', 'rtp', 'srtp', 'rtcp']
      });

      this.router = await this.worker.createRouter({
        mediaCodecs: this.config.mediaCodecs
      });

      this.worker.on('died', () => {
        this.logger.error('Mediasoup worker died');
        process.exit(1);
      });

      this.logger.info('Mediasoup worker ready', {
        routerRtpCapabilities: this.router.rtpCapabilities
      });
    } catch (error) {
      this.enabled = false;
      this.logger.warn('Mediasoup unavailable, running in mock transport mode', {
        error: error.message
      });
    }
  }

  async createWebRtcTransport() {
    if (!this.router) {
      throw new Error('Mediasoup router not started');
    }

    const transport = await this.router.createWebRtcTransport({
      listenIps: [
        {
          ip: this.config.listenIp,
          announcedIp: this.config.announcedIp
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: this.config.initialBitrate
    });

    this.logger.info('Created WebRTC transport', { id: transport.id });
    this.transports.set(transport.id, transport);

    transport.on('close', () => {
      this.transports.delete(transport.id);
    });

    return transport;
  }

  getTransport(transportId) {
    return this.transports.get(transportId) || null;
  }

  async connectTransport(transportId, dtlsParameters) {
    const transport = this.getTransport(transportId);

    if (!transport) {
      throw new Error(`Unknown transport ${transportId}`);
    }

    await transport.connect({ dtlsParameters });
    return transport;
  }

  getRouterRtpCapabilities() {
    if (!this.router) {
      return null;
    }

    return this.router.rtpCapabilities;
  }

  getCodec(kind) {
    return this.router.rtpCapabilities.codecs.find((codec) => codec.kind === kind);
  }

  async ensureRtpProducers() {
    if (!this.router) {
      throw new Error('Mediasoup router not started');
    }

    if (this.senderResources) {
      return this.senderResources;
    }

    const audioTransport = await this.router.createPlainTransport({
      listenIp: this.config.listenIp,
      rtcpMux: true,
      comedia: false
    });
    const videoTransport = await this.router.createPlainTransport({
      listenIp: this.config.listenIp,
      rtcpMux: true,
      comedia: false
    });

    await audioTransport.connect({ ip: this.config.listenIp, port: audioTransport.tuple.localPort });
    await videoTransport.connect({ ip: this.config.listenIp, port: videoTransport.tuple.localPort });

    const audioCodec = this.getCodec('audio');
    const videoCodec = this.getCodec('video');

    this.audioProducer = await audioTransport.produce({
      kind: 'audio',
      rtpParameters: {
        codecs: [
          {
            mimeType: audioCodec.mimeType,
            payloadType: audioCodec.preferredPayloadType,
            clockRate: audioCodec.clockRate,
            channels: audioCodec.channels,
            parameters: audioCodec.parameters || {}
          }
        ],
        encodings: [{ ssrc: this.senderProfile.audioSsrc }],
        rtcp: { cname: 'dataviv-audio' }
      }
    });

    this.videoProducer = await videoTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: videoCodec.mimeType,
            payloadType: videoCodec.preferredPayloadType,
            clockRate: videoCodec.clockRate,
            parameters: videoCodec.parameters || {}
          }
        ],
        encodings: [{ ssrc: this.senderProfile.videoSsrc }],
        rtcp: { cname: 'dataviv-video' }
      }
    });

    this.senderResources = {
      audioTransport,
      videoTransport,
      audioCodec,
      videoCodec
    };

    this.bindProducers({
      videoProducer: this.videoProducer,
      audioProducer: this.audioProducer
    });

    return this.senderResources;
  }

  async startRtpSource(source) {
    if (!this.enabled || !source?.storedVideoPath) {
      await this.stopRtpSource();
      return 0;
    }

    const startedAt = Date.now();
    const resources = await this.ensureRtpProducers();
    await this.stopRtpSource();

    const args = [
      '-re',
      '-stream_loop',
      '-1',
      '-i',
      source.storedVideoPath,
      '-map',
      '0:v:0',
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '5',
      '-b:v',
      '1500k',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-payload_type',
      String(resources.videoCodec.preferredPayloadType),
      '-ssrc',
      String(this.senderProfile.videoSsrc),
      '-f',
      'rtp',
      `rtp://${this.config.listenIp}:${resources.videoTransport.tuple.localPort}?pkt_size=1200`,
      '-map',
      '0:a:0?',
      '-c:a',
      'libopus',
      '-application',
      'lowdelay',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-vn',
      '-payload_type',
      String(resources.audioCodec.preferredPayloadType),
      '-ssrc',
      String(this.senderProfile.audioSsrc),
      '-f',
      'rtp',
      `rtp://${this.config.listenIp}:${resources.audioTransport.tuple.localPort}?pkt_size=1200`
    ];

    this.logger.info('Starting FFmpeg RTP sender', {
      sourceId: source.sourceId,
      input: source.storedVideoPath,
      ffmpegPath: this.config.ffmpegPath
    });

    const child = spawn(this.config.ffmpegPath || 'ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    this.currentSourceId = source.sourceId;
    this.lastSenderError = null;

    child.stderr.on('data', (chunk) => {
      const output = chunk.toString().trim();
      if (output) {
        this.logger.debug('FFmpeg RTP sender', { output });
      }
    });

    child.on('close', (code) => {
      this.logger.info('FFmpeg RTP sender stopped', { code });
      if (this.rtpSender?.pid === child.pid) {
        this.rtpSender = null;
      }
      if (code && code !== 0) {
        this.lastSenderError = `FFmpeg RTP sender exited with code ${code}`;
      }
    });

    child.on('error', (error) => {
      this.logger.error('FFmpeg RTP sender failed', { error: error.message });
      this.lastSenderError = error.message;
    });

    this.rtpSender = child;
    return Date.now() - startedAt;
  }

  async stopRtpSource() {
    if (!this.rtpSender) {
      return;
    }

    const child = this.rtpSender;
    this.rtpSender = null;
    this.currentSourceId = null;

    await new Promise((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGKILL');
    }).catch(() => {});
  }

  bindProducers({ videoProducer, audioProducer }) {
    this.videoProducer = videoProducer || this.videoProducer;
    this.audioProducer = audioProducer || this.audioProducer;
  }

  registerVideoConsumer(consumer) {
    this.videoConsumers.add(consumer);
    return () => this.videoConsumers.delete(consumer);
  }

  async switchProducerTracks({ nextVideoTrack, nextAudioTrack, source }) {
    const startedAt = Date.now();

    if (source?.storedVideoPath) {
      await this.startRtpSource(source);
      await Promise.all(
        Array.from(this.videoConsumers).map((consumer) => this.requestKeyFrame(consumer))
      );
      const latencyMs = Date.now() - startedAt;
      this.logger.info('Producer source switched via RTP sender restart', {
        sourceId: source.sourceId,
        latencyMs
      });
      return latencyMs;
    }

    if (!source?.storedVideoPath) {
      await this.stopRtpSource();
    }

    const operations = [];

    if (this.videoProducer && nextVideoTrack) {
      operations.push(this.videoProducer.replaceTrack({ track: nextVideoTrack }));
    }

    if (this.audioProducer && nextAudioTrack) {
      operations.push(this.audioProducer.replaceTrack({ track: nextAudioTrack }));
    }

    if (operations.length === 0) {
      this.logger.warn('Producer swap requested without bound tracks');
      return 0;
    }

    await Promise.all(operations);
    await Promise.all(
      Array.from(this.videoConsumers).map((consumer) => this.requestKeyFrame(consumer))
    );
    const latencyMs = Date.now() - startedAt;
    this.logger.info('Producer tracks swapped without transport renegotiation', { latencyMs });
    return latencyMs;
  }

  getProducerStatus() {
    return {
      hasVideoProducer: Boolean(this.videoProducer),
      hasAudioProducer: Boolean(this.audioProducer)
    };
  }

  describeRtcReadiness() {
    return {
      enabled: this.enabled,
      routerReady: Boolean(this.router),
      ...this.getProducerStatus(),
      transportCount: this.transports.size,
      senderActive: Boolean(this.rtpSender),
      currentSourceId: this.currentSourceId,
      lastSenderError: this.lastSenderError,
      canConsumeRemotely: Boolean(this.router && (this.videoProducer || this.audioProducer))
    };
  }

  async consume({ transportId, rtpCapabilities, kind }) {
    if (!this.router) {
      throw new Error('Mediasoup router not started');
    }

    const transport = this.getTransport(transportId);
    if (!transport) {
      throw new Error(`Unknown transport ${transportId}`);
    }

    const producer = kind === 'audio' ? this.audioProducer : this.videoProducer;
    if (!producer) {
      const error = new Error(`No ${kind} producer is currently bound`);
      error.statusCode = 409;
      throw error;
    }

    if (!this.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      const error = new Error(`Router cannot consume ${kind} with the provided RTP capabilities`);
      error.statusCode = 400;
      throw error;
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: false
    });

    if (kind === 'video') {
      this.registerVideoConsumer(consumer);
    }

    consumer.on('transportclose', () => {
      consumer.close();
    });

    return consumer;
  }

  async requestKeyFrame(consumer) {
    if (consumer && typeof consumer.requestKeyFrame === 'function') {
      await consumer.requestKeyFrame();
    }
  }

  describeInstantSwitch() {
    return {
      strategy: 'restart RTP sender on existing producers',
      renegotiationRequired: false,
      sequence: [
        'reuse stable producers created from PlainTransports',
        'restart FFmpeg RTP sender with the next source on the same ports and SSRCs',
        'request keyframe for downstream video consumers',
        'continue using same transports and consumers'
      ]
    };
  }
}

module.exports = {
  MediasoupManager
};
