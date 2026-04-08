const fs = require('node:fs/promises');
const path = require('node:path');
const { buildSyntheticSource, buildSourceFromManifest } = require('./frameTimeline');

class SourceRegistry {
  constructor(logger, sourceDir) {
    this.logger = logger;
    this.sourceDir = sourceDir;
    this.sources = new Map();
    this.syntheticSourceIds = new Set();
  }

  registerSyntheticSources() {
    const sourceOne = Object.assign(buildSyntheticSource({ sourceId: 1, fps: 30, durationSeconds: 30 }), {
      name: 'Synthetic 30 FPS'
    });
    const sourceTwo = Object.assign(buildSyntheticSource({ sourceId: 2, fps: 24, durationSeconds: 24 }), {
      name: 'Synthetic 24 FPS'
    });

    this.syntheticSourceIds.add(sourceOne.sourceId);
    this.syntheticSourceIds.add(sourceTwo.sourceId);

    this.registerSource(
      sourceOne
    );
    this.registerSource(
      sourceTwo
    );
  }

  registerSource(source) {
    this.sources.set(source.sourceId, source);
    this.logger.info('Registered media source', {
      sourceId: source.sourceId,
      fps: source.fps,
      totalFrames: source.totalFrames
    });
  }

  find(sourceId) {
    return this.sources.get(sourceId) || null;
  }

  get(sourceId) {
    const source = this.find(sourceId);
    if (!source) {
      throw new Error(`Unknown source ${sourceId}`);
    }
    return source;
  }

  list() {
    return Array.from(this.sources.values()).map((source) => ({
      sourceId: source.sourceId,
      name: source.name || `source-${source.sourceId}`,
      fps: source.fps,
      totalFrames: source.totalFrames,
      isSynthetic: this.syntheticSourceIds.has(source.sourceId),
      videoUrl: source.videoUrl || null,
      posterUrl: source.posterUrl || null
    }));
  }

  isSynthetic(sourceId) {
    return this.syntheticSourceIds.has(sourceId);
  }

  async delete(sourceId) {
    if (this.isSynthetic(sourceId)) {
      const error = new Error('Built-in synthetic sources cannot be deleted');
      error.statusCode = 400;
      throw error;
    }

    const source = this.find(sourceId);
    if (!source) {
      const error = new Error(`Unknown source ${sourceId}`);
      error.statusCode = 404;
      throw error;
    }

    await fs.rm(path.join(this.sourceDir, String(sourceId)), { recursive: true, force: true });
    this.sources.delete(sourceId);

    this.logger.info('Deleted media source', { sourceId });
  }

  async loadFromDisk() {
    await fs.mkdir(this.sourceDir, { recursive: true });
    const entries = await fs.readdir(this.sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifestPath = path.join(this.sourceDir, entry.name, 'manifest.json');
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        this.registerSource(buildSourceFromManifest(manifest));
      } catch (error) {
        this.logger.warn('Skipping source manifest', {
          manifestPath,
          error: error.message
        });
      }
    }
  }
}

module.exports = {
  SourceRegistry
};
