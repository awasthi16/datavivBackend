function createLogger(level = 'info') {
  const weights = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = weights[level] ?? weights.info;

  function log(method, message, meta) {
    if ((weights[method] ?? 100) < threshold) {
      return;
    }

    const timestamp = new Date().toISOString();
    if (meta === undefined) {
      console[method](`[${timestamp}] [${method.toUpperCase()}] ${message}`);
      return;
    }

    console[method](
      `[${timestamp}] [${method.toUpperCase()}] ${message} ${JSON.stringify(meta)}`
    );
  }

  return {
    debug(message, meta) {
      log('debug', message, meta);
    },
    info(message, meta) {
      log('info', message, meta);
    },
    warn(message, meta) {
      log('warn', message, meta);
    },
    error(message, meta) {
      log('error', message, meta);
    }
  };
}

module.exports = {
  createLogger
};
