import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultProviderModels,
  inferModelProvider,
  normalizeLegacyFallbackModel,
  providerDefaultsFromModelHint
} from '../src/modelSelection.js';

test('normalizes legacy sentinel values to null', () => {
  assert.equal(normalizeLegacyFallbackModel('innies/default'), null);
  assert.equal(normalizeLegacyFallbackModel(' INNIES/DEFAULT '), null);
});

test('infers known model families and leaves unknown models unassigned', () => {
  assert.equal(inferModelProvider('claude-opus-4-6'), 'anthropic');
  assert.equal(inferModelProvider('gpt-5.5'), 'openai');
  assert.equal(inferModelProvider('future-model-x'), null);
});

test('applies anthropic model hints without rewriting openai defaults', () => {
  assert.deepEqual(providerDefaultsFromModelHint('claude-opus-4-6'), {
    anthropic: 'claude-opus-4-6',
    openai: 'gpt-5.4'
  });
});

test('applies openai model hints without rewriting anthropic defaults', () => {
  assert.deepEqual(providerDefaultsFromModelHint('gpt-5.5'), {
    anthropic: 'claude-opus-4-7',
    openai: 'gpt-5.5'
  });
});

test('unknown model hints do not rewrite provider defaults', () => {
  assert.deepEqual(providerDefaultsFromModelHint('future-model-x'), defaultProviderModels());
});
