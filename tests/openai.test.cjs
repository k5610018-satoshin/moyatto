const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function app(initial = {}, responses = []) {
  const properties = { ADMIN_KEY: 'test-admin', ...initial };
  const requests = [];
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: name => properties[name] || null,
      setProperty: (name, value) => { properties[name] = value; },
      setProperties: values => Object.assign(properties, values),
      deleteProperty: name => { delete properties[name]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    Utilities: { sleep: () => {} },
    UrlFetchApp: { fetch: (url, options) => {
      requests.push({ url, ...options });
      if (!responses.length) throw new Error('No mocked response');
      const { status = 200, body } = responses.shift();
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
    } }
  });
  for (const name of ['Config.gs', 'Session.gs', 'Code.gs', 'OpenAI.gs']) {
    const file = path.join(__dirname, '..', 'src', name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: name });
  }
  return { context, properties, requests };
}

function completed(value) {
  return { status: 'completed', output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
  ] };
}

test('Luna medium request uses Responses API, strict JSON and no stored response', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [
    { body: completed({ ready: true }) }
  ]);
  const result = context.testAi('test-admin');
  assert.equal(result.ok, true);
  const request = requests[0];
  const body = JSON.parse(request.payload);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning.effort, 'medium');
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal('temperature' in body, false);
  assert.equal(JSON.stringify(result).includes('sk-mock'), false);
});

test('existing Gemini settings stay active until a new OpenAI key is registered', () => {
  const { context, properties } = app({ GEMINI_API_KEY: 'AIzaMockGeminiKeyForTestsOnly' });
  assert.equal(context.getAiProvider_(), 'gemini');
  context.setAiKey('test-admin', 'sk-mock-openai-key-for-tests-only');
  assert.equal(context.getAiProvider_(), 'openai');
  assert.equal(properties.GEMINI_API_KEY, 'AIzaMockGeminiKeyForTestsOnly');
  const settings = context.getSettings('test-admin');
  assert.equal(settings.aiReady, true);
  assert.equal(settings.model, 'gpt-6-luna');
  assert.equal(settings.reasoningEffort, 'medium');
  assert.equal(JSON.stringify(settings).includes('sk-mock'), false);
  assert.throws(() => context.setAiKey('wrong-admin', 'sk-mock-openai-key-for-tests-only'));
});

test('accepted reframes pass through the actual askMoyatto flow', () => {
  const verdict = { cleared: true, progress: 2, acceptedReframes: ['苦手が分かった', '点数と自分のよさは別'], reason: '2つの見方が見つかった', reply: 'ありがとう！' };
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [{ body: completed(verdict) }]);
  const result = context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text: '苦手が分かったし、点数だけで自分のよさは決まらないよ。' }] });
  assert.equal(result.cleared, true);
  assert.equal(result.progress, 2);
  const body = JSON.parse(requests[0].payload);
  assert.ok(body.instructions.includes('リフレーミング'));
  assert.ok(body.input[0].content.includes('児童の返事'));
});

test('incomplete, refused, malformed and failed responses never clear a card', () => {
  const cases = [
    { body: { ...completed({ cleared: true }), status: 'incomplete' } },
    { body: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot comply' }] }] } },
    { body: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not JSON' }] }] } },
    { status: 401, body: { error: { message: 'secret must not be forwarded' } } }
  ];
  for (const response of cases) {
    const { context } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [response]);
    const result = context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text: '苦手が分かったし、点数だけで自分のよさは決まらないよ。' }] });
    assert.equal(result.cleared, false);
    assert.equal(result.progress, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('heavy topics do not make an API request and one reframe cannot clear a card', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [
    { body: completed({ cleared: true, progress: 2, acceptedReframes: ['苦手が分かった'], reason: '', reply: 'ありがとう' }) }
  ]);
  assert.equal(context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text: 'いじめられている' }] }).cleared, false);
  assert.equal(requests.length, 0);
  const result = context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text: '苦手なところが分かったね。' }] });
  assert.equal(result.cleared, false);
  assert.equal(result.progress, 1);
});

test('optional fields become nullable and assistant turns remain assistant turns', () => {
  const { context } = app();
  const body = JSON.parse(JSON.stringify(context.openAiBody_('system', [
    { role: 'user', parts: [{ text: 'first' }] }, { role: 'model', parts: [{ text: 'reply' }] }
  ], { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, reason: { type: 'STRING' } }, required: ['ok'] })));
  assert.deepEqual(body.text.format.schema.properties.reason.type, ['string', 'null']);
  assert.deepEqual(body.text.format.schema.required, ['ok', 'reason']);
  assert.equal(body.input[1].role, 'assistant');
});

test('rate limits retry once and admin test errors do not expose API error bodies', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [
    { status: 429, body: { error: { message: 'private API detail' } } },
    { status: 429, body: { error: { message: 'private API detail' } } }
  ]);
  const result = context.testAi('test-admin');
  assert.equal(requests.length, 2);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('429'));
  assert.equal(result.error.includes('private API detail'), false);
});
