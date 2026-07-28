import path from 'node:path';
import { ConfigError } from './errors.js';

export const LIMITS = Object.freeze({
  maxFileSizeSearch: 500 * 1024,
  retryBaseDelayMs: 5000,
  retryBackoffFactor: 1.3,
  mcpTimeoutMs: 30_000,
  fetchTimeoutMs: 15_000,
  fetchMaxSize: 10 * 1024 * 1024,
  maxCompletionTokensSubagent: 32_000,
  maxToolOutput: 50_000,
  defaultAppName: 'agent-sdk',
});

export function sanitizeAppName(name) {
  if (typeof name !== 'string') throw new ConfigError(`appName must be a string (got ${typeof name})`);
  const trimmed = name.trim();
  if (!trimmed) throw new ConfigError('appName must not be empty');
  if (trimmed.includes('\0')) throw new ConfigError('appName must not contain null bytes');
  if (trimmed === '.' || trimmed === '..') throw new ConfigError('appName must not be "." or ".."');
  if (trimmed.includes('/') || trimmed.includes('\\') || path.basename(trimmed) !== trimmed) {
    throw new ConfigError('appName must be a single path segment (no path separators)');
  }
  return trimmed;
}

export function truncateOutput(text, maxChars = LIMITS.maxToolOutput) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated: ${text.length - maxChars} characters omitted]`;
}

export function hasMultimodalContent(payload) {
  if (!payload || !Array.isArray(payload.messages)) return false;
  return payload.messages.some((message) => {
    if ((message.role !== 'tool' && message.role !== 'user') || !Array.isArray(message.content)) return false;
    return message.content.some((part) => part && typeof part === 'object' && part.type !== 'text');
  });
}

export function degradePayload(payload) {
  if (!payload || !Array.isArray(payload.messages)) return;
  for (let index = 0; index < payload.messages.length; index += 1) {
    const message = payload.messages[index];
    if ((message.role !== 'tool' && message.role !== 'user') || !Array.isArray(message.content)) continue;
    if (!message.content.some((part) => part && typeof part === 'object' && part.type !== 'text')) continue;
    const textParts = message.content.filter((part) => part && (typeof part === 'string' || part.type === 'text'));
    const content = textParts.length
      ? textParts.map((part) => (typeof part === 'string' ? part : part.text)).join('\n')
      : '[non-text content omitted]';
    payload.messages[index] = { ...message, content };
  }
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / 1024 ** index).toFixed(1))}${['B', 'KB', 'MB', 'GB'][index]}`;
}
