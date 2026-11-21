const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/** テスト用の小さなスプレッドシート（使う操作だけ）。 */
function fakeSpreadsheetApp() {
  const books = {};
  let next = 1;
  function makeSheet(initialName) {
    let name = initialName;
    const rows = [];
    function range(r, c, nr = 1, nc = 1) {
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [];
            const vals = [];
            for (let j = 0; j < nc; j++) vals.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
            out.push(vals);
          }
          return out;
        },
        setValues(values) {
          for (let i = 0; i < nr; i++) {
            while (rows.length < r + i) rows.push([]);
            const row = rows[r - 1 + i];
            for (let j = 0; j < nc; j++) {
              while (row.length < c - 1 + j) row.push('');
              row[c - 1 + j] = values[i][j];
            }
          }
          return this;
        },
        setValue(value) { return this.setValues([[value]]); },
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        setFontWeight() { return this; }
      };
    }
    const sheet = {
      rows,
      getName: () => name,
      setName: n => { name = n; return sheet; },
      appendRow: values => { rows.push(values.slice()); return sheet; },
      getDataRange: () => range(1, 1, rows.length, rows.reduce((m, row) => Math.max(m, row.length), 0)),
      getLastRow: () => rows.length,
      getRange: (r, c, nr, nc) => range(r, c, nr, nc),
      deleteRow: r => { rows.splice(r - 1, 1); },
      setFrozenRows: () => sheet,
      autoResizeColumns: () => sheet
    };
    return sheet;
  }
  return {
    books,
    create() {
      const id = 'book-' + next++;
      const sheets = [makeSheet('Sheet1')];
      books[id] = {
        getId: () => id,
        getActiveSheet: () => sheets[0],
        getSheets: () => sheets.slice(),
        getSheetByName: n => sheets.find(s => s.getName() === n) || null,
        insertSheet: n => { const s = makeSheet(n); sheets.push(s); return s; }
      };
      return books[id];
    },
    openById(id) {
      if (!books[id]) throw new Error('no spreadsheet');
      return books[id];
    }
  };
}

function app(initial = {}, responses = []) {
  const properties = { ADMIN_KEY: 'test-admin', ...initial };
  const cache = {};
  const requests = [];
  const templates = [];
  const sheets = fakeSpreadsheetApp();
  const output = { setTitle() { return output; }, addMetaTag() { return output; }, setXFrameOptionsMode() { return output; } };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: name => properties[name] || null,
      setProperty: (name, value) => { properties[name] = value; },
      setProperties: values => Object.assign(properties, values),
      deleteProperty: name => { delete properties[name]; }
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { sleep() {}, getUuid: () => 'uuid-' + Math.random().toString(16).slice(2, 12) },
    SpreadsheetApp: sheets,
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example.invalid/exec' }) },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile(name) {
        const tpl = { name, evaluate: () => output };
        templates.push(tpl);
        return tpl;
      }
    },
    Logger: { log() {} },
    UrlFetchApp: { fetch: (url, options) => {
      requests.push({ url, ...options });
      if (!responses.length) throw new Error('No mocked response');
      const { status = 200, body } = responses.shift();
      return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
    } }
  });
  for (const name of ['Config.gs', 'Sheet.gs', 'Session.gs', 'Votes.gs', 'Code.gs', 'OpenAI.gs', 'Avatars.gs', 'UiImages.gs']) {
    const file = path.join(__dirname, '..', 'src', name);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: name });
  }
  return { context, properties, requests, templates, sheets };
}

function completed(value) {
  return { status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
  ] };
}

const judged = (extra = {}) => completed({ cleared: false, progress: 0, acceptedReframes: [], reason: '', reply: 'うーん', concern: false, ...extra });

test('a disclosure the keyword list misses goes to adult support when the AI marks it as the child’s own concern', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [{ body: judged({ concern: true }) }]);
  const text = 'ほんとは ぼくも 学校で ずっと ひとりで つらい';
  assert.equal(context.isHeavyTopic_(text), false);
  const result = context.askMoyatto({ troubleId: 'test', messages: [{ role: 'user', text }] });
  assert.equal(result.support, true);
  assert.equal(result.cleared, false);
  assert.equal(requests.length, 1);
  const schema = JSON.parse(requests[0].payload).text.format.schema;
  assert.ok(schema.required.includes('concern'));

  const gemini = app();
  const parsed = gemini.context.parseResult_(JSON.stringify({ cleared: false, progress: 0, acceptedReframes: [], reason: '', reply: '', concern: true }));
  assert.equal(parsed.support, true);
});

test('the judging instructions explain how to respond to a child’s own hardship instead of avoiding it', () => {
  const { context } = app();
  const prompt = context.buildSystemPrompt_(context.findTrouble_('test'), []);
  assert.ok(prompt.includes('【安全】'));
  assert.ok(prompt.includes('concern'));
  assert.equal(prompt.includes('いじめ・暴力など重い話はしない'), false);
});

test('clear disclosure wording is caught before any API call, while advice-like wording is left to the AI', () => {
  const { context } = app();
  const heavy = ['きのう たたかれた', 'ろうかで なぐられた', '友だちに けられた', 'くつを かくされた', 'お金を とられた',
    '家に 帰りたくない', 'もう いなくなりたい', '死ね って言われた', 'ずっと わるぐちを 言われる', 'つねられた'];
  for (const text of heavy) assert.equal(context.isHeavyTopic_(text), true, text);
  const ordinary = ['友だちに たすけられた', 'いいところを 見つけられた', 'むしされた わけじゃ ないかも',
    'かくされた よさが あるかも', '写真を とられた', 'なかまはずれじゃ ないよ', '二人が 笑った わけは まだ 分からない'];
  for (const text of ordinary) assert.equal(context.isHeavyTopic_(text), false, text);
  for (const t of context.getTroubles_()) {
    for (const s of [t.label, t.serihu, t.fact, t.take, t.tip].concat(t.reframes || [])) {
      assert.equal(context.isHeavyTopic_(s), false, t.id + ': ' + s);
    }
  }
});

test('a support signal reaches the teacher without any of the child’s words, and the teacher can clear it', () => {
  const { context, sheets } = app();
  const { code } = context.createSession('test-admin', '体験');
  const { pid } = context.joinSession(code, 'たろう');
  assert.equal(context.flagSupport(code, pid), true);
  let me = context.getDashboard('test-admin', code).leaderboard[0];
  assert.equal(me.name, 'たろう');
  assert.ok(me.supportAt);
  const book = Object.values(sheets.books)[0];
  const row = book.getSheetByName('participants').rows[1];
  assert.equal(row.length, 8);
  assert.equal(row.some(v => typeof v === 'string' && /つらい|たたか/.test(v)), false);
  assert.throws(() => context.clearSupportFlag('wrong-key', code, pid));
  assert.equal(context.clearSupportFlag('test-admin', code, pid), true);
  me = context.getDashboard('test-admin', code).leaderboard[0];
  assert.equal(me.supportAt, '');
  assert.equal(context.flagSupport(code, 'someone-else'), false);
});

test('a view once accepted is not taken back when the early turns fall outside the history window', () => {
  const { context, requests } = app({ OPENAI_API_KEY: 'sk-mock-value-for-unit-tests-only' }, [{ body: judged({ progress: 0 }) }]);
  const messages = [{ role: 'user', text: '次に練習する場所が分かった' }, { role: 'model', text: 'なるほど' }];
  for (let i = 0; i < 8; i++) messages.push({ role: 'user', text: 'うーん ' + i }, { role: 'model', text: 'ほかには？' });
  messages.push({ role: 'user', text: 'がんばれ' });
  const result = context.askMoyatto({ troubleId: 'test', messages, acceptedReframes: ['次に練習する場所が分かった'] });
  assert.equal(result.progress, 1);
  assert.deepEqual(Array.from(result.acceptedReframes), ['次に練習する場所が分かった']);
  const body = JSON.parse(requests[0].payload);
  assert.equal(body.input.some(t => t.content.includes('次に練習する場所が分かった')), false);
  assert.ok(body.instructions.includes('1. 次に練習する場所が分かった'));
});

test('the child page does not carry the reference answers used for judging', () => {
  const { context, templates } = app();
  context.doGet({ parameter: {} });
  const cards = JSON.parse(templates[0].troublesJson.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
  assert.equal(cards.length, 49);
  assert.equal(cards.some(t => 'reframes' in t), false);
  assert.ok(context.findTrouble_('test').reframes.length >= 2);
});

test('a teacher can correct a proposed card and add judging views before approving it', () => {
  const { context, templates } = app();
  const saved = context.addProposal_('はなこ', '発表でまちがえた', {
    type: 'dekigoto', label: 'はっぴょう', serihu: 'まちがえちゃった', fact: 'まちがえた', take: 'ダメだ', tip: 'どうかな'
  });
  assert.equal(saved.ok, true);
  const pending = context.listProposals('test-admin', 'pending');
  assert.equal(pending.length, 1);
  assert.throws(() => context.setProposalStatus('test-admin', saved.id, 'approved', { label: '', serihu: 'a', fact: 'b', take: 'c' }));
  assert.equal(context.setProposalStatus('test-admin', saved.id, 'approved', {
    type: 'dekigoto', label: '発表で 言いまちがえた', serihu: '発表で 一か所 言いまちがえたんだ…。', fact: '発表で 一か所 言いまちがえた',
    take: '「発表は ぜんぶ 失敗だ」', tip: '言いまちがえたのは、発表の どこかな？',
    reframes: ['まちがえたのは発表の一か所だ。', '気づいて言い直せたのは、聞く人に届けたかったからかも。', '']
  }), true);
  const card = context.findTrouble_(saved.id);
  assert.equal(card.label, '発表で 言いまちがえた');
  assert.deepEqual(Array.from(card.reframes), ['まちがえたのは発表の一か所だ。', '気づいて言い直せたのは、聞く人に届けたかったからかも。']);
  assert.ok(context.buildSystemPrompt_(card, []).includes('まちがえたのは発表の一か所だ。'));
  context.doGet({ parameter: {} });
  const cards = JSON.parse(templates[0].troublesJson.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
  const shown = cards.find(t => t.id === saved.id);
  assert.equal(shown.label, '発表で 言いまちがえた');
  assert.equal('reframes' in shown, false);
});

test('functions the screens do not call are private to the server', () => {
  const { context } = app();
  for (const name of ['addScore', 'saveReframe', 'addProposal', '_findParticipant', '_updateParticipant']) {
    assert.equal(typeof context[name], 'undefined', name);
  }
  for (const name of ['addScore_', 'saveReframe_', 'addProposal_', 'findParticipant_', 'updateParticipant_', 'flagSupport', 'clearSupportFlag']) {
    assert.equal(typeof context[name], 'function', name);
  }
  const html = ['index.html', 'admin.html'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  for (const name of ['addScore', 'saveReframe(', 'addProposal']) assert.equal(html.includes('.' + name), false, name);
  assert.ok(html.includes('.flagSupport('));
  assert.ok(html.includes('.clearSupportFlag('));
});
