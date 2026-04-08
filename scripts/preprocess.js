const path = require('node:path');
const config = require('../src/config');
const { createLogger } = require('../src/utils/logger');
const { MediaPreprocessor } = require('../src/media/preprocessor');

async function main() {
  const inputPath = process.argv[2];
  const sourceId = Number.parseInt(process.argv[3] || Date.now().toString(), 10);
  const name = process.argv[4] || path.basename(inputPath || `source-${sourceId}`);

  if (!inputPath) {
    throw new Error('Usage: npm run preprocess -- <inputPath> [sourceId] [name]');
  }

  const logger = createLogger(config.app.logLevel);
  const preprocessor = new MediaPreprocessor(
    {
      sourceDir: config.storage.sourceDir,
      ffmpegPath: config.mediaTools.ffmpegPath,
      ffprobePath: config.mediaTools.ffprobePath
    },
    logger
  );
  const manifest = await preprocessor.preprocess({ inputPath, sourceId, name });
  console.log(JSON.stringify({ ok: true, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
