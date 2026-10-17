/** OpenAI Responses API。キーは Script Properties にだけ保存する。 */
var OPENAI_MODEL = 'gpt-6-luna';
var OPENAI_REASONING_EFFORT = 'medium';

function getAiProvider_() {
  var props = PropertiesService.getScriptProperties();
  var provider = props.getProperty('AI_PROVIDER');
  if (provider === 'openai' || provider === 'gemini') return provider;
  return props.getProperty('OPENAI_API_KEY') ? 'openai' : 'gemini';
}

function getAiModel_() {
  return getAiProvider_() === 'openai' ? OPENAI_MODEL : MODEL;
}

/** 管理画面で入力したキーの種類から保存先を決める。値は返さない。 */
function setAiKey(adminKey, key) {
  requireAdmin_(adminKey);
  key = String(key || '').trim();
  var provider;
  if (/^sk-[A-Za-z0-9_-]+$/.test(key) && key.length >= 24) provider = 'openai';
  else if (/^AIza[A-Za-z0-9_-]+$/.test(key) && key.length >= 24) provider = 'gemini';
  else throw new Error('OpenAI または Gemini のAPIキーを確認してください。');
  var props = PropertiesService.getScriptProperties();
  props.setProperties(provider === 'openai'
    ? { OPENAI_API_KEY: key, AI_PROVIDER: provider }
    : { GEMINI_API_KEY: key, AI_PROVIDER: provider });
  props.deleteProperty('TRIAL_MODE');
  return { ok: true, provider: provider, model: getAiModel_() };
}

/** Gemini のスキーマを Responses API の strict JSON Schema に変換。 */
function openAiSchema_(schema) {
  schema = schema || {};
  var out = { type: String(schema.type || 'OBJECT').toLowerCase() };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.slice();
  if (out.type === 'object') {
    out.properties = {};
    out.additionalProperties = false;
    var properties = schema.properties || {};
    var required = schema.required || [];
    Object.keys(properties).forEach(function (name) {
      var child = openAiSchema_(properties[name]);
      // strict は全プロパティを required にする。元の任意項目には null を許す。
      if (required.indexOf(name) < 0) child.type = [child.type, 'null'];
      out.properties[name] = child;
    });
    out.required = Object.keys(properties);
  } else if (out.type === 'array') {
    out.items = openAiSchema_(schema.items);
  }
  return out;
}

function openAiBody_(systemText, contents, schema) {
  return {
    model: OPENAI_MODEL,
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    store: false,
    max_output_tokens: 4096,
    instructions: String(systemText || ''),
    input: (contents || []).map(function (c) {
      return {
        role: c.role === 'model' || c.role === 'assistant' ? 'assistant' : 'user',
        content: (c.parts || []).map(function (p) { return String(p.text || ''); }).join('\n')
      };
    }),
    text: {
      format: { type: 'json_schema', name: 'moyatto_response', strict: true, schema: openAiSchema_(schema) }
    }
  };
}

/** HTTP応答本文や例外文は利用者に返さず、キーと入力内容の露出を防ぐ。 */
function openAiRequest_(body) {
  var key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_KEY_MISSING');
  var options = {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body), muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', options);
  var status = response.getResponseCode();
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    Utilities.sleep(800 + Math.floor(Math.random() * 400));
    response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', options);
  }
  return response;
}

function openAiReadJson_(response) {
  if (response.getResponseCode() !== 200) throw new Error('OPENAI_HTTP_' + response.getResponseCode());
  var data = JSON.parse(response.getContentText());
  if (data.status !== 'completed' || data.error) throw new Error('OPENAI_INCOMPLETE');
  var text = '';
  (data.output || []).forEach(function (item) {
    if (item.type !== 'message' || item.role !== 'assistant') return;
    (item.content || []).forEach(function (part) {
      if (part.type === 'refusal') throw new Error('OPENAI_REFUSAL');
      if (part.type === 'output_text') text += String(part.text || '');
    });
  });
  if (!text) throw new Error('OPENAI_EMPTY');
  return JSON.parse(text);
}

function openAiJson_(systemText, contents, schema, fallback) {
  try {
    return openAiReadJson_(openAiRequest_(openAiBody_(systemText, contents, schema)));
  } catch (e) {
    return fallback;
  }
}

function callOpenAi_(systemText, contents) {
  var schema = {
    type: 'OBJECT',
    properties: {
      cleared: { type: 'BOOLEAN' }, progress: { type: 'INTEGER' },
      acceptedReframes: { type: 'ARRAY', items: { type: 'STRING' } },
      reason: { type: 'STRING' }, reply: { type: 'STRING' }
    },
    required: ['cleared', 'progress', 'acceptedReframes', 'reason', 'reply']
  };
  var data = openAiJson_(systemText, contents, schema, null);
  if (!data) return friendlyFallback_(contents.length <= 1);
  return result_(data.cleared === true, data.progress, data.acceptedReframes, data.reason, data.reply);
}

/** 管理者だけが実行できる、本番と同じJSON形式での疎通テスト。 */
function testAi(adminKey) {
  requireAdmin_(adminKey);
  if (getAiProvider_() !== 'openai') return testGemini(adminKey);
  if (!hasApiKey_()) return { ok: false, error: 'OpenAI APIキーが未設定です。' };
  var schema = {
    type: 'OBJECT', properties: { ready: { type: 'BOOLEAN' } }, required: ['ready']
  };
  try {
    var response = openAiRequest_(openAiBody_('接続テストです。ready=true を返してください。',
      [{ role: 'user', parts: [{ text: '接続を確認してください。' }] }], schema));
    var status = response.getResponseCode();
    if (status !== 200) {
      var messages = {
        400: 'リクエスト設定を確認してください。',
        401: 'OpenAI APIキーを確認してください。',
        403: 'このプロジェクトのモデル利用権限を確認してください。',
        404: 'このプロジェクトで GPT-6 Luna が利用できるか確認してください。',
        429: 'OpenAI の利用上限・残高・混雑状況を確認してください。'
      };
      return { ok: false, error: 'HTTP ' + status + ': ' + (messages[status] || 'しばらくしてから再度テストしてください。') };
    }
    var data = openAiReadJson_(response);
    if (data.ready !== true) return { ok: false, error: 'AIの応答を確認できませんでした。' };
    return { ok: true, provider: 'openai', model: OPENAI_MODEL, reasoningEffort: OPENAI_REASONING_EFFORT };
  } catch (e) {
    return { ok: false, error: 'OpenAI の通信または応答形式を確認できませんでした。' };
  }
}
