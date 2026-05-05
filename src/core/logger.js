import config from '../config.js';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[0;31m',
  yellow: '\x1b[0;33m',
  dim: '\x1b[2m',
};

const prefix = (color) => `${color}*${colors.reset}`;

export const logger = {
  error: (msg, ...args) => {
    console.error(`${prefix(colors.red)} ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`${prefix(colors.yellow)} [WARN] ${msg}`, ...args);
  },
  debug: (msg, ...args) => {
    if (config.DEBUG) {
      console.log(`${prefix(colors.dim)} [DEBUG] ${msg}`, ...args);
    }
  },
  info: (msg, ...args) => {
    console.log(`${prefix(colors.dim)} [INFO] ${msg}`, ...args);
  }
};

export default logger;
