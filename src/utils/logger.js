const isProduction = process.env.NODE_ENV === 'production';

/**
 * Format a log entry.
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Object} [data]
 * @returns {string}
 */
function format(level, message, data) {
  const timestamp = new Date().toISOString();

  if (isProduction) {
    return JSON.stringify({ timestamp, level, message, ...data });
  }

  const dataStr = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] ${level}: ${message}${dataStr}`;
}

module.exports = {
  info(message, data = {}) {
    console.log(format('INFO', message, data));
  },
  warn(message, data = {}) {
    console.warn(format('WARN', message, data));
  },
  error(message, data = {}) {
    console.error(format('ERROR', message, data));
  },
};
