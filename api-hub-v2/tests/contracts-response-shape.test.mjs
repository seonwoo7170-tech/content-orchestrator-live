import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonText, parseModelText } from '../src/lib/contracts.js';

test('parseModelText reads classic response text', () => {
  assert.equal(parseModelText({ response: ' OK ' }), 'OK');
});

test('parseModelText reads Responses API output_text', () => {
  assert.equal(parseModelText({ output_text: ' hello ' }), 'hello');
});

test('parseModelText reads Responses API message content output_text', () => {
  assert.equal(parseModelText({
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }
    ]
  }), '{"ok":true}');
});

test('parseModelText reads wrapped Responses API output', () => {
  assert.equal(parseModelText({
    result: {
      output: [{ content: [{ output_text: 'wrapped' }] }]
    }
  }), 'wrapped');
});

test('parseJsonText accepts fenced and embedded JSON while preserving braces inside strings', () => {
  assert.deepEqual(parseJsonText('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(
    parseJsonText('Repair reasoning complete.\n{"article":{"title":"A {safe} title","html":"<p>done</p>"}}\nEnd.'),
    { article: { title: 'A {safe} title', html: '<p>done</p>' } }
  );
});

test('parseJsonText still rejects truncated provider output', () => {
  assert.throws(
    () => parseJsonText('{"status":"FAIL","issues":['),
    (error) => error?.message === 'AI_PROVIDER_JSON_INVALID' && error?.status === 502
  );
});
