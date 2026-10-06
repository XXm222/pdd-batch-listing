const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelClient, ModelToolFormatError } = require('../dist-electron/electron/model-client');
const client = () =>
  new ModelClient({ baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: '' });
const call = (id = 'one', extra = {}) => ({
  id,
  type: 'function',
  function: { name: 'read_form_fields', arguments: '{}' },
  ...extra,
});
async function response(message, work) {
  const original = global.fetch;
  global.fetch = async () => Response.json({ choices: [{ message, finish_reason: 'tool_calls' }] });
  try {
    await work();
  } finally {
    global.fetch = original;
  }
}

test('compatible tool transport normalizes object arguments, omitted type and more than two calls', async () => {
  const calls = [
    call('one'),
    call('two', { type: undefined, function: { name: 'read_task_facts', arguments: {} } }),
    call('three', { function: { name: 'wait_form_ready', arguments: ' '.repeat(250) + '{}' } }),
  ];
  await response({ content: null, tool_calls: calls }, async () => {
    const r = await client().complete([{ role: 'user', content: 'fixture' }]);
    assert.equal(r.message.tool_calls.length, 3);
    assert.equal(r.message.tool_calls[1].type, 'function');
    assert.equal(r.message.tool_calls[1].function.arguments, '{}');
    assert.deepEqual(JSON.parse(r.message.tool_calls[2].function.arguments), {});
  });
});

test('ambiguous tool structures produce redacted typed errors without coercing IDs or parameters', async () => {
  const malformed = [
    { calls: { private: 'do not record' }, reason: /数组/ },
    { calls: [call('')], reason: /ID/ },
    { calls: [call('one'), call('one')], reason: /重复/ },
    { calls: [call('one', { type: 'custom' })], reason: /function/ },
    {
      calls: [
        call('one', { function: { name: 'read_form_fields', arguments: ['private-value'] } }),
      ],
      reason: /JSON 字符串或对象/,
    },
    { calls: Array.from({ length: 7 }, (_, i) => call(String(i))), reason: /6 个/ },
  ];
  for (const { calls, reason } of malformed)
    await response({ content: null, tool_calls: calls }, async () => {
      await assert.rejects(
        client().complete([{ role: 'user', content: 'fixture' }]),
        (e) =>
          e instanceof ModelToolFormatError &&
          reason.test(e.message) &&
          !e.message.includes('private'),
      );
    });
});
