const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function run(command, args, logger) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Required media tool not found: ${command}. Install FFmpeg/FFprobe or set its full path in the environment.`
          )
        );
        return;
      }

      reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      if (logger) {
        logger.debug(`${command} completed`, { args });
      }
      resolve(stdout.trim());
    });
  });
}

function parseFps(value) {
  if (!value || value === '0/0') {
    return 30;
  }

  const [num, denom] = value.split('/').map(Number);
  if (!num || !denom) {
    return Number(value) || 30;
  }

  return num / denom;
}

class MediaPreprocessor {
  constructor({ sourceDir, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' }, logger) {
    this.sourceDir = sourceDir;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.logger = logger;
  }

  async ensureStorage() {
    await fs.mkdir(this.sourceDir, { recursive: true });
  }

  createPublicStoragePath(...segments) {
    return `/storage/${segments.join('/').replace(/\\/g, '/')}`;
  }

  async probe(inputPath) {
    const output = await run(
      this.ffprobePath,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        inputPath
      ],
      this.logger
    );

    const meta = JSON.parse(output);
    const videoStream = meta.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = meta.streams.find((stream) => stream.codec_type === 'audio');

    if (!videoStream) {
      throw new Error('Input file has no video stream');
    }

    return {
      durationSeconds: Number.parseFloat(meta.format.duration || videoStream.duration || '0'),
      fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate),
      audioSampleRate: Number.parseInt(audioStream?.sample_rate || '48000', 10)
    };
  }

  async preprocess({ inputPath, sourceId, name }) {
    await this.ensureStorage();
    const sourceRoot = path.join(this.sourceDir, String(sourceId));
    const frameDir = path.join(sourceRoot, 'frames');
    const audioDir = path.join(sourceRoot, 'audio');
    const mediaDir = path.join(sourceRoot, 'media');

    await fs.mkdir(frameDir, { recursive: true });
    await fs.mkdir(audioDir, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });

    const extension = path.extname(inputPath) || '.mp4';
    const originalFilename = `original${extension}`;
    const storedVideoPath = path.join(mediaDir, originalFilename);
    await fs.copyFile(inputPath, storedVideoPath);

    const probe = await this.probe(inputPath);
    const fps = Math.max(1, Math.round(probe.fps));
    const totalFrames = Math.max(1, Math.ceil(probe.durationSeconds * fps));
    const frameDurationMs = 1000 / fps;

    await run(
      this.ffmpegPath,
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `fps=${fps},scale=640:-1`,
        path.join(frameDir, 'frame-%06d.jpg')
      ],
      this.logger
    );

    await run(
      this.ffmpegPath,
      [
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '2',
        '-ar',
        '48000',
        path.join(audioDir, 'full.wav')
      ],
      this.logger
    );

    const manifest = {
      sourceId,
      name,
      inputPath,
      sourceRoot,
      fps,
      totalFrames,
      durationSeconds: probe.durationSeconds,
      frameDurationMs,
      videoUrl: this.createPublicStoragePath('sources', String(sourceId), 'media', originalFilename),
      posterUrl: this.createPublicStoragePath('sources', String(sourceId), 'frames', 'frame-000001.jpg'),
      frames: Array.from({ length: totalFrames }, (_, index) => ({
        index,
        ptsMs: Number((index * frameDurationMs).toFixed(3)),
        durationMs: Number(frameDurationMs.toFixed(3)),
        payloadRef: this.createPublicStoragePath(
          'sources',
          String(sourceId),
          'frames',
          `frame-${String(index + 1).padStart(6, '0')}.jpg`
        )
      })),
      audioChunks: Array.from({ length: totalFrames }, (_, index) => ({
        index,
        ptsMs: Number((index * frameDurationMs).toFixed(3)),
        durationMs: Number(frameDurationMs.toFixed(3)),
        payloadRef: this.createPublicStoragePath('sources', String(sourceId), 'audio', 'full.wav'),
        offsetMs: Number((index * frameDurationMs).toFixed(3))
      }))
    };

    await fs.writeFile(
      path.join(sourceRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    return manifest;
  }

  async persistUploadedFile(file) {
    await this.ensureStorage();

    const uploadId = randomUUID();
    const uploadRoot = path.join(this.sourceDir, '..', 'uploads');
    await fs.mkdir(uploadRoot, { recursive: true });

    const extension = path.extname(file.originalname || '') || '.mp4';
    const storedPath = path.join(uploadRoot, `${uploadId}${extension}`);
    await fs.rename(file.path, storedPath);

    return storedPath;
  }
}

module.exports = {
  MediaPreprocessor
};
