function buildSyntheticSource({
  sourceId,
  fps = 30,
  durationSeconds = 30,
  audioSampleRate = 48000,
  audioChunkSamples = 1600
}) {
  const totalFrames = fps * durationSeconds;
  const frameDurationMs = 1000 / fps;
  const audioChunkDurationMs = (audioChunkSamples / audioSampleRate) * 1000;

  const videoFrames = Array.from({ length: totalFrames }, (_, index) => ({
    index,
    ptsMs: Number((index * frameDurationMs).toFixed(3)),
    durationMs: Number(frameDurationMs.toFixed(3)),
    payloadRef: `${sourceId}:video:${index}`
  }));

  const audioChunks = videoFrames.map((frame) => ({
    index: frame.index,
    ptsMs: frame.ptsMs,
    durationMs: Number(audioChunkDurationMs.toFixed(3)),
    payloadRef: `${sourceId}:audio:${frame.index}`
  }));

  return {
    sourceId,
    fps,
    totalFrames,
    frameDurationMs,
    videoFrames,
    audioChunks
  };
}

function getFramePair(source, frameIndex) {
  const normalizedIndex = ((frameIndex % source.totalFrames) + source.totalFrames) % source.totalFrames;
  return {
    video: source.videoFrames[normalizedIndex],
    audio: source.audioChunks[normalizedIndex]
  };
}

function buildSourceFromManifest(manifest) {
  return {
    sourceId: manifest.sourceId,
    name: manifest.name || `source-${manifest.sourceId}`,
    fps: manifest.fps,
    totalFrames: manifest.totalFrames,
    frameDurationMs: manifest.frameDurationMs,
    videoUrl: manifest.videoUrl || null,
    posterUrl: manifest.posterUrl || null,
    videoFrames: manifest.frames,
    audioChunks: manifest.audioChunks
  };
}

module.exports = {
  buildSyntheticSource,
  buildSourceFromManifest,
  getFramePair
};
