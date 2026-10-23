import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedRequestTracker,
  ProtocolValidationError,
  assertReplyMatchesRequest,
  makeRequest,
  parseJsonEnvelope,
  validateReplyEnvelope,
  validateRequestEnvelope,
} from '../lib/protocol-v2.js';

const validRequest = () => ({ protocol: 2, session_id: 'S1', request_id: 1, command: 'ping', params: {} });
const validReply = () => ({ protocol: 2, session_id: 'S1', request_id: 1, status: 'ok', result: { pong: true } });

test('valid request and reply envelopes pass', () => {
  assert.deepEqual(validateRequestEnvelope(validRequest()), validRequest());
  assert.deepEqual(validateReplyEnvelope(validReply()), validReply());
});

test('request requires every identity and command field', () => {
  for (const key of ['protocol', 'session_id', 'request_id', 'command', 'params']) {
    const value = validRequest();
    delete value[key];
    assert.throws(() => validateRequestEnvelope(value), ProtocolValidationError, key);
  }
});

test('wrong protocol fails visibly', () => {
  const value = validRequest();
  value.protocol = 1;
  assert.throws(() => validateRequestEnvelope(value), (err) => err.code === 'PROTOCOL_MISMATCH');
});

test('malformed JSON is classified', () => {
  assert.throws(
    () => parseJsonEnvelope('{nope', validateRequestEnvelope, 'request'),
    (err) => err.code === 'INVALID_REQUEST',
  );
  assert.throws(
    () => parseJsonEnvelope('{nope', validateReplyEnvelope, 'response'),
    (err) => err.code === 'INVALID_RESPONSE',
  );
});

test('reply status/error payload is strict', () => {
  assert.throws(
    () => validateReplyEnvelope({ ...validReply(), status: 'wat' }),
    (err) => err.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => validateReplyEnvelope({ protocol: 2, session_id: 'S1', request_id: 1, status: 'error', error: 'boom' }),
    (err) => err.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => validateReplyEnvelope({ protocol: 2, session_id: 'S1', request_id: 1, status: 'error', error: { code: 'MADE_UP', message: 'boom' } }),
    (err) => err.code === 'INVALID_RESPONSE',
  );
  assert.throws(
    () => validateReplyEnvelope({ protocol: 2, session_id: 'S1', request_id: 1, status: 'error', result: {}, error: { code: 'COMMAND_FAILED', message: 'boom' } }),
    (err) => err.code === 'INVALID_RESPONSE',
  );
});

test('stale session and request IDs never match the active request', () => {
  const request = validRequest();
  assert.throws(
    () => assertReplyMatchesRequest({ ...validReply(), session_id: 'OLD' }, request),
    (err) => err.code === 'STALE_RESPONSE',
  );
  assert.throws(
    () => assertReplyMatchesRequest({ ...validReply(), request_id: 99 }, request),
    (err) => err.code === 'STALE_RESPONSE',
  );
});

test('bounded tracker rejects duplicate IDs still in its dedupe window', () => {
  const tracker = new BoundedRequestTracker(2);
  assert.equal(tracker.accept('S1', 1), true);
  assert.equal(tracker.accept('S1', 1), false);
  assert.equal(tracker.accept('S1', 2), true);
  assert.equal(tracker.accept('S1', 3), true);
  assert.equal(tracker.accept('S1', 1), true, 'evicted IDs leave the bounded in-memory window');
  assert.equal(tracker.accept('S2', 1), true, 'new session resets in-memory dedupe');
});

test('makeRequest rejects invalid params instead of silently coercing', () => {
  assert.throws(
    () => makeRequest({ sessionId: 'S1', requestId: 1, command: 'ping', params: [] }),
    (err) => err.code === 'INVALID_REQUEST',
  );
});
