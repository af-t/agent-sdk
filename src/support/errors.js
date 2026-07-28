export class SdkError extends Error {
  constructor(message, { code = 'SDK_ERROR', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
  }
}

export class ApiError extends SdkError {
  constructor(message, { status, body, cause } = {}) {
    super(message, { code: 'API_ERROR', cause });
    this.status = status;
    this.body = body;
  }
}

export class ToolError extends SdkError {
  constructor(message, { toolName, cause } = {}) {
    super(message, { code: 'TOOL_ERROR', cause });
    this.toolName = toolName;
  }
}

export class ConfigError extends SdkError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'CONFIG_ERROR' });
  }
}

export class AbortError extends SdkError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ABORT_ERROR' });
  }
}
