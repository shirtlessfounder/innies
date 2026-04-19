import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCorrelationId, buildSessionId } from '../src/utils.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('buildCorrelationId returns a v4 UUID per call', () => {
  const a = buildCorrelationId();
  const b = buildCorrelationId();
  assert.match(a, UUID_V4);
  assert.match(b, UUID_V4);
  assert.notEqual(a, b);
});

test('buildSessionId returns a v4 UUID per call', () => {
  const a = buildSessionId();
  const b = buildSessionId();
  assert.match(a, UUID_V4);
  assert.match(b, UUID_V4);
  assert.notEqual(a, b);
});

test('buildSessionId and buildCorrelationId produce independent ids', () => {
  const correlation = buildCorrelationId();
  const session = buildSessionId();
  assert.notEqual(correlation, session);
});
