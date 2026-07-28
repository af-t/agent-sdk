export class ConfigError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
  }
}
