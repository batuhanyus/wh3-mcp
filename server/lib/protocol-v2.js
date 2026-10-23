export const PROTOCOL_VERSION = 2;

export const ERROR_CODES = Object.freeze([
  'GAME_NOT_RUNNING',
  'NOT_READY',
  'IO_FAILURE',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'PROTOCOL_MISMATCH',
  'STALE_RESPONSE',
  'COMMAND_TIMEOUT',
  'CONTEXT_CHANGED',
  'GAME_EXITED',
  'COMMAND_FAILED',
  'UNSUPPORTED_CAPABILITY',
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);

export class ProtocolValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateIdentity(value, kind) {
  if (value.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'PROTOCOL_MISMATCH',
      `${kind}.protocol must be ${PROTOCOL_VERSION}`,
      { received: value.protocol },
    );
  }
  if (typeof value.session_id !== 'string' || value.session_id.trim() === '' || value.session_id.length > 256) {
    throw new ProtocolValidationError('INVALID_' + kind.toUpperCase(), `${kind}.session_id must be a non-empty string <= 256 characters`);
  }
  if (!Number.isSafeInteger(value.request_id) || value.request_id < 1) {
    throw new ProtocolValidationError('INVALID_' + kind.toUpperCase(), `${kind}.request_id must be a positive safe integer`);
  }
}

export function validateRequestEnvelope(value) {
  if (!isPlainObject(value)) {
    throw new ProtocolValidationError('INVALID_REQUEST', 'request must be a JSON object');
  }
  validateIdentity(value, 'request');
  if (typeof value.command !== 'string' || value.command.trim() === '') {
    throw new ProtocolValidationError('INVALID_REQUEST', 'request.command must be a non-empty string');
  }
  if (!isPlainObject(value.params)) {
    throw new ProtocolValidationError('INVALID_REQUEST', 'request.params must be a JSON object');
  }
  return value;
}

export function validateReplyEnvelope(value) {
  if (!isPlainObject(value)) {
    throw new ProtocolValidationError('INVALID_RESPONSE', 'reply must be a JSON object');
  }
  validateIdentity(value, 'response');
  if (value.status !== 'ok' && value.status !== 'error') {
    throw new ProtocolValidationError('INVALID_RESPONSE', 'reply.status must be "ok" or "error"');
  }
  if (value.status === 'ok') {
    if (Object.prototype.hasOwnProperty.call(value, 'error')) {
      throw new ProtocolValidationError('INVALID_RESPONSE', 'ok reply must not contain error');
    }
  } else {
    if (Object.prototype.hasOwnProperty.call(value, 'result')) {
      throw new ProtocolValidationError('INVALID_RESPONSE', 'error reply must not contain result');
    }
    if (!isPlainObject(value.error)) {
      throw new ProtocolValidationError('INVALID_RESPONSE', 'error reply must contain an error object');
    }
    if (!ERROR_CODE_SET.has(value.error.code)) {
      throw new ProtocolValidationError('INVALID_RESPONSE', `unknown error code: ${String(value.error.code)}`);
    }
    if (typeof value.error.message !== 'string' || value.error.message.trim() === '') {
      throw new ProtocolValidationError('INVALID_RESPONSE', 'error.message must be a non-empty string');
    }
  }
  return value;
}

export function parseJsonEnvelope(text, validator, kind = 'message') {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const code = kind === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE';
    throw new ProtocolValidationError(code, `malformed ${kind} JSON`, { cause: error.message });
  }
  return validator(value);
}

export function assertReplyMatchesRequest(reply, request) {
  validateReplyEnvelope(reply);
  validateRequestEnvelope(request);
  if (reply.protocol !== request.protocol) {
    throw new ProtocolValidationError('PROTOCOL_MISMATCH', 'reply protocol does not match request');
  }
  if (reply.session_id !== request.session_id || reply.request_id !== request.request_id) {
    throw new ProtocolValidationError('STALE_RESPONSE', 'reply identity does not match the active request', {
      expected: { session_id: request.session_id, request_id: request.request_id },
      received: { session_id: reply.session_id, request_id: reply.request_id },
    });
  }
  return reply;
}

export function makeRequest({ sessionId, requestId, command, params = {} }) {
  return validateRequestEnvelope({
    protocol: PROTOCOL_VERSION,
    session_id: sessionId,
    request_id: requestId,
    command,
    params,
  });
}

export function makeErrorReply({ sessionId, requestId, code, message, details }) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return validateReplyEnvelope({
    protocol: PROTOCOL_VERSION,
    session_id: sessionId,
    request_id: requestId,
    status: 'error',
    error,
  });
}

export class BoundedRequestTracker {
  constructor(limit = 128) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    this.limit = limit;
    this.sessionId = null;
    this.ids = new Set();
    this.order = [];
  }

  reset(sessionId) {
    this.sessionId = sessionId;
    this.ids.clear();
    this.order.length = 0;
  }

  accept(sessionId, requestId) {
    if (this.sessionId !== sessionId) this.reset(sessionId);
    if (this.ids.has(requestId)) return false;
    this.ids.add(requestId);
    this.order.push(requestId);
    while (this.order.length > this.limit) {
      this.ids.delete(this.order.shift());
    }
    return true;
  }
}
