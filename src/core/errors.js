export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class ToolError extends Error {
  constructor(message, toolName) {
    super(message);
    this.name = 'ToolError';
    this.toolName = toolName;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
