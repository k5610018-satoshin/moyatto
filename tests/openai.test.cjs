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

test('Sol 6.2 medium request uses Responses API, strict JSON and no stored response', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [
    { body: completed({ ready: true }) }
  ]);
  const result = context.testAi('test-admin');
  assert.equal(result.ok, true);
  const request = requests[0];
  const body = JSON.parse(request.payload);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.model, 'gpt-6.2-sol');
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
  assert.equal(settings.model, 'gpt-6.2-sol');
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

test('an encouraging opening can be followed by a genuine reframe', () => {
  const verdict = { cleared: false, progress: 1, acceptedReframes: ['練習する場所が分かった'], reason: '', reply: 'なるほど' };
  const { context, requests } = app({ OPENAI_API_KEY: 'test-key' }, [{ body: completed(verdict) }]);
  const answer = text => context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text }] });
  assert.equal(answer('ドンマイ！').cleared, false);
  assert.equal(requests.length, 0);
  assert.equal(answer('ドンマイ。今回の点で、練習する場所が分かったよ。').progress, 1);
  assert.equal(requests.length, 1);
});

test('two strings cannot override an explicit non-clear verdict; punctuation alone is not a new idea', () => {
  const { context } = app();
  const mismatch = context.result_(false, 0, ['練習する場所が分かった', '自分のよさは点数だけで決まらない'], '', '');
  assert.equal(mismatch.cleared, false);
  assert.equal(mismatch.retryable, true);
  const duplicate = context.result_(true, 2, ['練習する場所が分かった', '練習する 場所が分かった。'], '', '');
  assert.equal(duplicate.cleared, false);
  assert.equal(duplicate.progress, 1);
});

test('temporary failures allow retry while a model refusal offers adult support', () => {
  const refused = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{type: 'refusal'}] }] };
  const { context } = app({ OPENAI_API_KEY: 'test-key' }, [{ status: 503 }, { status: 503 }, { body: refused }]);
  const input = { troubleId: 'test', messages: [{role: 'user', text: '練習する場所が分かった。'}] };
  assert.equal(context.askMoyatto(input).retryable, true);
  const support = context.askMoyatto(input);
  assert.equal(support.support, true);
  assert.equal(support.cleared, false);
  assert.equal(support.retryable, undefined);
});

test('a later ordinary answer does not include an earlier sensitive disclosure in its API input', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'test-key' }, [
    { body: completed({cleared: false, progress: 1, acceptedReframes: ['練習する場所が分かった'], reason: '', reply: 'なるほど'}) }
  ]);
  const messages = [{role: 'user', text: 'いじめられている'}];
  assert.equal(context.askMoyatto({ troubleId: 'test', messages }).support, true);
  assert.equal(requests.length, 0);
  messages.push({role: 'model', text: '相談してね。'}, {role: 'user', text: '練習する場所が分かった。'});
  assert.equal(context.askMoyatto({ troubleId: 'test', messages }).progress, 1);
  const turns = JSON.parse(requests[0].payload).input;
  assert.equal(turns.length, 1);
  assert.ok(turns[0].content.includes('練習する場所が分かった'));
  assert.ok(!turns[0].content.includes('いじめられている'));
});

test('the same card and hint number change with the child’s answers, including earlier accepted ideas', () => {
  const { context, requests } = app();
  function hint(text, extra = {}) {
    return context.moreHint({ troubleId: 'test', hintIndex: 1, messages: text ? [{ role: 'user', text }] : [], ...extra });
  }
  assert.equal(hint('').angle, 'meaning');
  assert.equal(hint('わからない').angle, 'notice');
  assert.equal(hint('ドンマイ！').angle, 'anchor');
  assert.equal(hint('次に練習する場所が分かった').angle, 'scope');
  assert.equal(hint('今回の点だけでぜんぶは決まらない').angle, 'learning');
  assert.notEqual(hint('苦手なところが見えた', { acceptedReframes: ['次に練習する所が分かった'] }).angle, 'learning');
  assert.equal(requests.length, 0);
});

test('three hints have different questions and angles on every standard card, including older clients', () => {
  const { context } = app();
  const cards = context.getTroubles_();
  assert.equal(cards.length, 49);
  assert.equal(new Set(cards.map(t => t.id)).size, 49);
  assert.equal(cards.filter(t => t.type === 'dekigoto').length, 27);
  assert.equal(context.auditDefaultReframes_().length, 0);
  for (const t of cards) {
    const shown = [], legacy = [];
    for (let n = 1; n <= 3; n++) {
      const r = context.moreHint({ troubleId: t.id, messages: [{ role: 'user', text: 'わからない' }], shownHints: shown, hintIndex: n });
      assert.ok(r.hint && r.hint !== t.tip && !t.reframes.includes(r.hint), t.id);
      shown.push(r);
      legacy.push(context.moreHint({ troubleId: t.id, hintIndex: n }).hint);
    }
    assert.equal(new Set(shown.map(h => h.angle)).size, 3, t.id);
    assert.equal(new Set(shown.map(h => h.hint)).size, 3, t.id);
    assert.equal(new Set(legacy).size, 3, t.id);
  }
  assert.equal(context.moreHint({ troubleId: 'missing' }).retryable, true);
});

test('the AI receives the actual learner context, separate from the judging history and identity', () => {
  const adaptive = '点数に書いてないモヤットのことは何かな？';
  const { context, requests } = app({ OPENAI_API_KEY: 'fixture' }, [{ body: completed({ hint: adaptive, needsAdult: false }) }]);
  const r = context.moreHint({ troubleId: 'test', classCode: 'not-for-model', draft: 'not-sent',
    messages: [{ role: 'user', text: 'ドンマイ' }, { role: 'model', text: 'どこを見てみたい？' },
      { role: 'user', text: '次の練習に使える' }], acceptedReframes: ['練習する場所が分かった'],
    shownHints: [{ angle: 'notice', hint: '答案を見て、たしかに分かることは何かな？' }] });
  assert.equal(r.hint, adaptive);
  const body = JSON.parse(requests[0].payload), data = JSON.parse(body.input[0].content);
  assert.equal(body.model, 'gpt-6.2-sol');
  assert.deepEqual(data.answers, ['ドンマイ', '次の練習に使える']);
  assert.deepEqual(data.accepted, ['練習する場所が分かった']);
  assert.ok(data.recentReplies.includes('どこを見てみたい？'));
  assert.equal(data.earlierHints.length, 2);
  assert.equal(/not-for-model|not-sent/.test(requests[0].payload), false);
});

test('repeated, malformed and failed AI hints fall back without repeating a previous angle', () => {
  const first = { angle: 'notice', hint: '見えていることを一つ選ぶなら？' };
  const messages = [{ role: 'user', text: 'ドンマイ' }];
  for (const response of [{ body: completed({ hint: first.hint, needsAdult: false }) },
    { body: completed({ hint: '見えていることを一つ選ぶなら何かな？', needsAdult: false }) },
    { body: completed({ hint: '勉強するところが分かったね。', needsAdult: false }) }, { status: 503, body: {} }]) {
    const { context } = app({ OPENAI_API_KEY: 'fixture' }, [response]);
    const r = context.moreHint({ troubleId: 'test', messages, shownHints: [first], hintIndex: 2 });
    assert.ok(r.hint.endsWith('？'));
    assert.notEqual(r.hint, first.hint);
    assert.notEqual(r.angle, first.angle);
  }
});

test('adult support takes precedence and a previous disclosure is omitted from subsequent hints', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'fixture' }, [{ body: completed({ hint: '', needsAdult: true }) }]);
  const personal = '毎日みんなに無視される';
  const q = { troubleId: 'test', messages: [{ role: 'user', text: personal }] };
  assert.equal(context.moreHint(q).support, true);
  assert.equal(requests.length, 0);
  q.messages.push({ role: 'user', text: '次に練習する所が分かった' });
  q.acceptedReframes = ['古い答え']; q.shownHints = [{ angle: 'scope', hint: '前のヒント' }];
  assert.equal(context.moreHint(q).support, true);
  assert.doesNotMatch(requests[0].payload, /無視される|古い答え|前のヒント/);
  const refusal = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] };
  const other = app({ OPENAI_API_KEY: 'fixture' }, [{ body: refusal }]);
  assert.equal(other.context.moreHint({ troubleId: 'test', messages: [{ role: 'user', text: '話しにくいことがある' }] }).support, true);
});

test('ordinary cards and teacher-supplied cards use their own situation for hints', () => {
  const { context, requests } = app({ GEMINI_API_KEY: 'fixture' }, [{ body: {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ hint: 'その絵のどこをもう一度見てみたい？', needsAdult: false }) }] } }]
  } }]);
  const card = { id: 'local-teacher-card', type: 'dekigoto', label: '絵', fact: '絵の色が混ざった', take: '全部失敗だ', tip: 'どんな色になったかな？' };
  context.getApprovedExtraTroubles_ = () => [card];
  const r = context.moreHint({ troubleId: card.id, messages: [{ role: 'user', text: 'ほかの色になったね' }] });
  assert.equal(r.hint, 'その絵のどこをもう一度見てみたい？');
  assert.ok(JSON.parse(requests[0].payload).systemInstruction.parts[0].text.includes(card.fact));
  assert.equal(context.findTrouble_('kenka').take.includes('相手が 悪い'), false);
  assert.doesNotMatch(context.findTrouble_('kyushoku').reframes.join(''), /早めに準備|速く食/);
});

test('teacher edits and older sheets never inherit reference answers for a different situation', () => {
  const { context } = app();
  const original = context.DEFAULT_TROUBLES.find(t => t.id === 'kakari');
  const old = { ...original, fact: '時計係で合図が遅れた', take: '時計係に向いていない' };
  assert.equal(context.enrichTroubles_([old])[0].reframes, undefined);
  const custom = { ...old, reframes: ['時間の知らせ方を知る手がかりだ'] };
  assert.equal(context.enrichTroubles_([custom])[0].reframes[0], custom.reframes[0]);
  const same = context.DEFAULT_TROUBLES.find(t => t.id === 'test');
  const { reframes, ...sheetRow } = same;
  assert.equal(context.enrichTroubles_([sheetRow])[0].reframes[0], reframes[0]);
});
