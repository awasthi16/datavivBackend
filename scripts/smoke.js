const { encodeCommand, parseCommand } = require('../src/protocol/commands');
const { buildSyntheticSource, getFramePair } = require('../src/media/frameTimeline');

function main() {
  const packet = encodeCommand({
    action: 3,
    streamId: 1,
    frameIndex: 42,
    timestamp: 1400.25,
    speed: 1.0
  });

  const parsed = parseCommand(packet);
  if (parsed.frameIndex !== 42 || parsed.actionName !== 'SEEK') {
    throw new Error('Binary protocol smoke test failed');
  }

  const source = buildSyntheticSource({ sourceId: 9, fps: 30, durationSeconds: 5 });
  const pair = getFramePair(source, 12);
  if (pair.video.ptsMs !== pair.audio.ptsMs) {
    throw new Error('A/V sync smoke test failed');
  }

  console.log(
    JSON.stringify({
      ok: true,
      parsed,
      samplePair: pair
    })
  );
}

main();
