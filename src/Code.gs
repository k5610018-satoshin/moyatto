/**
 * モヤット — エントリポイント（Webアプリ配信 + Gemini呼び出し）
 *
 * 構成:
 *   - doGet      : 児童の端末に index.html を配信。モード・悩みプールをサーバ側で埋め込む。
 *   - askMoyatto : クライアントが google.script.run で呼ぶ。Geminiに問い合わせ
 *                  {cleared, progress, acceptedReframes, reason, reply} を返す。
 *
 * Gemini APIキーはサーバ（スクリプトプロパティ）にのみ存在し、端末には一切出さない。
 */

// 入力の上限（濫用・トークン肥大の抑制）
var MAX_MESSAGES = 16;        // 直近この件数だけGeminiに送る
var MAX_TEXT_LEN = 1000;      // 1発言の最大文字数
var RATE_PER_MIN = 120;       // 全体で1分あたりの上限呼び出し回数（超過は静かにフォールバック）

function doGet(e) {
  e = e || {};
  var p = e.parameter || {};

  // 先生用ダッシュボード（?admin=鍵）
  if (p.admin !== undefined) {
    var atpl = HtmlService.createTemplateFromFile('admin');
    var adminConfigured = !!getAdminKey_();
    var validKey = (adminConfigured && p.admin === getAdminKey_()) ? p.admin : '';
    atpl.adminKeyJson = safeJson_(validKey);
    atpl.adminConfiguredJson = safeJson_(adminConfigured);
    atpl.webappUrlJson = safeJson_(getWebappUrl_());
    return atpl.evaluate()
      .setTitle('モヤット 先生用')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  // 児童用（単体 or ?s=コード でセッション参加）
  var tpl = HtmlService.createTemplateFromFile('index');
  var sCode = String(p.s || '').toUpperCase();
  tpl.modesJson = safeJson_(MODES);
  tpl.troublesJson = safeJson_(getTroubles_());
  tpl.avatarsJson = safeJson_(getAvatars_());
  tpl.uiImagesJson = safeJson_(getUiImages_());
  tpl.sessionJson = safeJson_({ code: sCode, mode: getSessionMode(sCode), flags: getSessionFlags_(sCode) });
  return tpl.evaluate()
    .setTitle('モヤットを たすけよう')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  e = e || {};
  var p = e.parameter || {};
  var body = {};
  try {
    if (e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = {};
  }
  var action = String(p.action || body.action || '');
  var adminKey = String(p.admin || body.admin || '');
  if (action === 'initializeAdminKey' && !getAdminKey_()) {
    return jsonOutput_(initializeAdminKey(String(p.key || body.key || '')));
  }
  if (action === 'setGeminiKey' && getAdminKey_() && adminKey === getAdminKey_()) {
    var key = String(p.key || body.key || '').trim();
    if (!key) return jsonOutput_({ ok: false, message: 'key is empty' });
    PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
    return jsonOutput_({ ok: true, geminiSet: true });
  }
  if (getAdminKey_() && adminKey === getAdminKey_()) {
    if (action === 'askMoyatto') {
      return jsonOutput_({ ok: true, result: askMoyatto(body.request || {}) });
    }
    if (action === 'moreHint') {
      return jsonOutput_({ ok: true, result: moreHint(body.request || {}) });
    }
    if (action === 'auditReframes') {
      return jsonOutput_({ ok: true, missing: auditDefaultReframes_() });
    }
    if (action === 'setAdminKey') {
      return jsonOutput_(setAdminKey(adminKey, String(p.key || body.key || '')));
    }
    if (action === 'setSessionFlags') {
      return jsonOutput_({ ok: true, flags: setSessionFlags(adminKey, String(p.code || body.code || ''), body.flags || {}) });
    }
  }
  return jsonOutput_({ ok: false, message: 'forbidden' });
}

function getWebappUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * <script> 文脈に安全に埋め込めるJSON文字列にする。
 * 「</script>」偽装を防ぐため < > & をユニコードエスケープに置換する（これで閉じタグ注入を無効化）。
 * ※ これは「< > & の置換 + JSON.stringify による引用符/バックスラッシュの正規化」で安全になる仕組み。
 *    渡す obj は先生が管理するデータ（MODES / 悩みプール）のみで、児童の入力は通さない。
 */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * クライアントから呼ばれるサーバ関数。
 * payload = { troubleId: string, messages: [{ role:'user'|'model', text:string }, ...] }
 * 返り値   = { cleared: boolean, progress: 0|1|2, acceptedReframes: string[], reason: string, reply: string }
 */
function askMoyatto(payload) {
  payload = payload || {};
  var trouble = findTrouble_(payload.troubleId);
  if (!trouble) {
    return result_(false, 0, [], '', 'ごめん、この なやみが 見つからなかったみたい。先生に 伝えてね。');
  }

  // 直近 MAX_MESSAGES 件に絞り、各発言を上限文字数でクランプ（トークン肥大・濫用の抑制）
  var raw = (payload.messages || []).slice(-MAX_MESSAGES);
  var contents = raw.map(function (m) {
    var role = (m && m.role === 'assistant') ? 'model' : (m && m.role) || 'user';
    if (role !== 'user' && role !== 'model') role = 'user';
    var text = String((m && m.text) || '').slice(0, MAX_TEXT_LEN);
    return { role: role, parts: [{ text: text }] };
  }).filter(function (c) { return c.parts[0].text.length > 0; });
  contents = dropLeadingModelTurns_(contents);

  if (!contents.length || contents[0].role !== 'user') {
    return { cleared: false, reply: 'え、それって どういうこと？ もうちょっと 教えて？' };
  }

  // 安全ネット: 子どもが自由入力欄に重い話題（自傷・暴力・いじめ等）を書いた場合は、
  // Geminiに渡さず、やさしく「信頼できる大人へ」と促す（言い換えの対象にしない）。
  var lastUser = lastUserText_(contents);
  if (isHeavyTopic_(lastUser)) {
    return result_(false, 0, [], '', 'それは、とっても 大事な こと。ひとりで がまん しないでね。おうちの人か 先生に、お話 してみて。');
  }

  // 軽量ヒューリスティック（初手のみ）: 明らかに浅い返事は Gemini に渡さず、ヒントを添えて聞き返す。
  // ※「3回でやさしく受け取る」を壊さないよう、最初の一手だけに限定する。迷うものは Gemini に委ねる。
  if (contents.length <= 1) {
    var quick = obviouslyShallow_(lastUser, trouble);
    if (quick) return { cleared: false, reply: quick };
  }

  // AIキー未設定のときは、誤解を生む「聞き返し」や偽の「解決」でなく、先生に分かる明確な案内を返す。
  if (!hasApiKey_()) {
    return result_(false, 0, [], '', '先生が AIの じゅんびを しているよ。先生に つたえてね。');
  }

  // 全体レート制限（超過時は静かにフォールバック＝授業を止めない）
  if (isRateLimited_()) {
    return friendlyFallback_(contents.length <= 1);
  }

  return callGemini_(buildSystemPrompt_(trouble), labelJudgementContents_(contents));
}

function result_(cleared, progress, acceptedReframes, reason, reply) {
  progress = Math.max(0, Math.min(2, Number(progress || 0)));
  var arr = Array.isArray(acceptedReframes) ? acceptedReframes : [];
  arr = arr.map(function (s) { return String(s || '').trim().slice(0, 120); })
    .filter(function (s, i, a) { return s && a.indexOf(s) === i; })
    .slice(0, 2);
  if (arr.length > progress) progress = arr.length;
  if (progress >= 2 && arr.length >= 2) cleared = true;
  if (arr.length < 2) {
    cleared = false;
    progress = Math.min(progress, arr.length);
  }
  if (cleared) progress = 2;
  return {
    cleared: cleared === true,
    progress: progress,
    acceptedReframes: arr,
    reason: childReason_(reason, arr, cleared === true, progress),
    reply: String(reply || 'ありがとう。もう少し、ちがう見方を いっしょに 探してみたいな。').trim()
  };
}

/** 児童画面に出す理由を、専門用語の少ない短い言葉に整える。 */
function childReason_(reason, acceptedReframes, cleared, progress) {
  var arr = Array.isArray(acceptedReframes) ? acceptedReframes : [];
  var s = String(reason || '').trim();
  if (!s && cleared && arr.length >= 2) {
    s = '2つの見方で、モヤットの気もちが軽くなったからだよ。';
  } else if (!s && progress === 1) {
    s = 'いい見方が1つ見つかったから、少しだけ心が軽くなったよ。';
  } else if (!s) {
    s = 'まだ、モヤットの気もちが軽くなる見方を探しているところだよ。';
  }

  var pairs = [
    ['有効なリフレーミング', '気もちが軽くなる見方'],
    ['リフレーミング', '見方の変え方'],
    ['有効な見方', 'いい見方'],
    ['有効な', 'いい'],
    ['提示された', '教えてくれた'],
    ['提示した', '教えてくれた'],
    ['判定しました', '思ったよ'],
    ['判定した', '思ったよ'],
    ['判定', ''],
    ['進捗', '進みぐあい'],
    ['意味づけ', '考え方'],
    ['視点', '見方'],
    ['事実', 'ほんとうにあったこと'],
    ['児童', 'きみ'],
    ['ユーザー', 'きみ'],
    ['該当', 'あてはまる'],
    ['成立', 'できている'],
    ['根拠', 'わけ']
  ];
  for (var i = 0; i < pairs.length; i++) {
    s = s.split(pairs[i][0]).join(pairs[i][1]);
  }
  s = s.replace(/ためです。?$/g, 'からだよ。')
       .replace(/ため。?$/g, 'からだよ。')
       .replace(/です。$/g, 'だよ。')
       .replace(/\s+/g, ' ')
       .trim();
  if (s.length > 130) s = s.slice(0, 127) + '...';
  return s;
}

/** contents の中で最後の user 発言テキストを返す。 */
function lastUserText_(contents) {
  for (var i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role === 'user') return contents[i].parts[0].text;
  }
  return '';
}

/** ヒントだけを先に見た時など、先頭のモヤット発言を判定会話から外す。 */
function dropLeadingModelTurns_(contents) {
  var i = 0;
  while (i < (contents || []).length && contents[i].role !== 'user') i++;
  return (contents || []).slice(i);
}

/** Geminiが児童の返事を「質問」や「会話の前置き」と誤読しないよう、判定対象を明示する。 */
function labelJudgementContents_(contents) {
  return (contents || []).map(function (c) {
    var role = (c && c.role === 'model') ? 'model' : 'user';
    var text = String(c && c.parts && c.parts[0] && c.parts[0].text || '');
    return {
      role: role,
      parts: [{
        text: (role === 'user')
          ? '児童の返事（この文をリフレーミングとして判定する）:\n' + text
          : '直前のモヤットの返事（文脈用。判定対象ではない）:\n' + text
      }]
    };
  });
}

/** 重い話題の軽量ガード（完全ではないが、明白なものを拾う安全ネット）。 */
function isHeavyTopic_(text) {
  if (!text) return false;
  var t = String(text);
  var deny = [
    '死にたい', 'しにたい', '消えたい', 'きえたい', '殺す', '殺し', 'ころして', 'ころされ',
    'リストカット', 'リスカ', '自殺', 'じさつ',
    'いじめられ', 'いじめてくる', '殴られ', '殴る', '蹴られ', '蹴って', 'たたかれて', '叩かれ',
    'さわられ', '触られ', '虐待', 'ぎゃくたい'
  ];
  for (var i = 0; i < deny.length; i++) {
    if (t.indexOf(deny[i]) !== -1) return true;
  }
  return false;
}

/** 全体で1分あたりの呼び出し回数を制限する（匿名公開時の濫用抑制）。失敗時は通す。 */
function isRateLimited_() {
  try {
    var cache = CacheService.getScriptCache();
    var bucket = 'rl_' + Math.floor(Date.now() / 60000);
    var lock = LockService.getScriptLock();
    lock.waitLock(2000);
    var n = parseInt(cache.get(bucket) || '0', 10) + 1;
    cache.put(bucket, String(n), 90);  // 90秒で自然消滅
    lock.releaseLock();
    return n > RATE_PER_MIN;
  } catch (e) {
    return false;  // 制限器の不調で正規利用を止めない
  }
}

/** モデル世代に応じた thinkingConfig を返す（Gemini 3.x=thinkingLevel / 2.x=thinkingBudget）。 */
function thinkingConfig_() {
  if (/^gemini-3/i.test(MODEL)) {
    return { thinkingLevel: THINKING_LEVEL };
  }
  return { thinkingBudget: THINKING_BUDGET };
}

/** Gemini generateContent を呼び構造化判定を返す。失敗時はクリアにしない。 */
function callGemini_(systemText, contents) {
  var firstTurn = contents.length <= 1;
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(MODEL) + ':generateContent?key=' +
            encodeURIComponent(getApiKey_());

  var body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: contents,
    generationConfig: {
      temperature: TEMPERATURE,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          cleared: { type: 'BOOLEAN' },
          progress: { type: 'INTEGER' },
          acceptedReframes: { type: 'ARRAY', items: { type: 'STRING' } },
          reason: { type: 'STRING' },
          reply: { type: 'STRING' }
        },
        required: ['cleared', 'progress', 'acceptedReframes', 'reason', 'reply']
      },
      thinkingConfig: thinkingConfig_()
    },
    // 子ども向けなので中リスク以上を遮断（自由入力欄からの誘導に備える）
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
    ]
  };

  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      return friendlyFallback_(firstTurn);
    }
    var data = JSON.parse(res.getContentText());
    // Gemini 3.x は思考の part が混ざることがあるので、text を持つ part を探す
    var cand = data.candidates && data.candidates[0];
    var parts = cand && cand.content && cand.content.parts;
    var text = '';
    if (parts) {
      for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi] && typeof parts[pi].text === 'string' && parts[pi].text) { text = parts[pi].text; break; }
      }
    }
    if (!text) {
      return friendlyFallback_(firstTurn);
    }
    return parseResult_(text, firstTurn);
  } catch (e) {
    return friendlyFallback_(firstTurn);
  }
}

/** モデル出力（JSON文字列）を構造化判定に変換。万一の崩れにも耐える。 */
function parseResult_(text, firstTurn) {
  var clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    var obj = JSON.parse(clean);
    return result_(
      obj.cleared === true,
      obj.progress,
      obj.acceptedReframes,
      obj.reason,
      (typeof obj.reply === 'string' && obj.reply.trim()) ? obj.reply.trim() : 'ありがとう。もう一つ、ちがう見方も 探してみよう。'
    );
  } catch (e) {
    return friendlyFallback_(firstTurn);
  }
}

/**
 * 通信や解析に失敗したときのフォールバック。
 * 初手の失敗だけは「やさしくもう一回聞く」に倒し、§3/§6 の“やさしい一回の問い返し”を障害時に飛ばさない。
 * 方針転換後は、障害時に「できたこと」にしない。
 */
function friendlyFallback_(firstTurn) {
  if (firstTurn) {
    return result_(false, 0, [], '', 'ごめん、うまく 聞こえなかったみたい。もう一回 おしえて?');
  }
  return result_(false, 0, [], '', 'ごめん、今の見方を うまく 確かめられなかったよ。クリアには しないで、もう一回だけ ちがう言い方で 教えてくれる?');
}

/**
 * 明らかに浅い初手だけを、Gemini に渡す前に拾う軽量ヒューリスティック。
 * 返り値: 聞き返し用の文字列（拾ったとき）/ '' （AIに任せるとき）。
 * 迷ったら '' を返し、判断は Gemini に委ねる（過剰検出で良い見方を弾かないため）。
 */
function obviouslyShallow_(text, trouble) {
  var t = String(text || '').trim();
  if (!t) return '';
  if (t.length < 3) return 'もうちょっと くわしく、"ちがう 見方" を おしえて? ヒント: 事実は そのままで、どう 考えると 楽に なるかな?';
  var skip = ['気にしないで', 'きにしないで', '気にするな', 'きにするな', 'わすれて', '忘れて', 'どんまい', 'ドンマイ'];
  for (var i = 0; i < skip.length; i++) {
    if (t.indexOf(skip[i]) !== -1) {
      return 'ありがとう。でも まだ もやもやするんだ。ヒント: 事実は 変えられないけど、その "見方" を べつの ふうに できないかな?';
    }
  }
  // 事実をそのまま書き写しただけ
  if (trouble && trouble.fact) {
    var norm = function (s) { return String(s).replace(/\s/g, ''); };
    if (norm(t) === norm(trouble.fact)) {
      return 'それは "事実" だね。ヒント: その 事実の "受け取り方" を 変えられないかな?';
    }
  }
  return '';
}

/**
 * 汎用 Gemini JSON 呼び出し（responseSchema で構造化）。失敗時は fallback をそのまま返す。
 * askMoyatto の callGemini_ とは別系統（{cleared,reply} 以外: もっとヒント / 悩み構造化）。
 */
function geminiJson_(systemText, contents, schema, fallback) {
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(getApiKey_());
    var body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: contents,
      generationConfig: {
        temperature: TEMPERATURE,
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: thinkingConfig_()
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
      ]
    };
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return fallback;
    var data = JSON.parse(res.getContentText());
    var cand = data.candidates && data.candidates[0];
    var parts = cand && cand.content && cand.content.parts;
    var text = '';
    if (parts) {
      for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi] && typeof parts[pi].text === 'string' && parts[pi].text) { text = parts[pi].text; break; }
      }
    }
    if (!text) return fallback;
    var clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) { return fallback; }
}

/**
 * もっとヒント: 行きづまった子に、別角度の "考えるヒント" を一つ返す（答えは言わない）。
 * payload = { troubleId, hintIndex }  →  返り値 = { hint }
 */
function moreHint(payload) {
  payload = payload || {};
  var trouble = findTrouble_(payload.troubleId);
  var fb = { hint: 'ヒント: 起きたことは そのままにして、「別の理由はあるかな?」「よい面はあるかな?」と考えてみよう。' };
  if (!trouble) return fb;
  return { hint: guidedHint_(trouble, payload.hintIndex || payload.hintCount || 1) };
}

function guidedHint_(trouble, hintIndex) {
  var n = Math.max(1, Math.min(3, parseInt(hintIndex || 1, 10) || 1));
  if (trouble && trouble.type === 'seikaku') {
    if (n === 1) return 'ヒント: その特徴が 役に立つ場面は、どんな時かな?';
    if (n === 2) return 'ヒント: 同じ特徴を 友だちが持っていたら、どんなよさに 見えるかな?';
    return 'ヒント: 困る場面と 助かる場面を 分けて考えると、何が見えてくるかな?';
  }
  if (n === 1) return 'ヒント: もし友だちに 同じことが起きたら、全部だめだと 思うかな?';
  if (n === 2) return 'ヒント: この出来事から、次に工夫できる 小さなことは 何かな?';
  return 'ヒント: その一つの出来事だけで、ぜんぶを 決めつけていないかな?';
}

/**
 * 参加者の悩み追加: 子どもが書いた困りごとを Gemini で悩みカードに構造化し、
 * 安全判定の上で「先生承認待ち（pending）」として保存する（Session.gs addProposal）。
 * 返り値 = { ok, message, heavy? }
 */
function proposeTrouble(rawText, name) {
  rawText = String(rawText || '').trim().slice(0, MAX_TEXT_LEN);
  if (rawText.length < 4) return { ok: false, message: 'もう少し くわしく 書いてね。' };
  if (isHeavyTopic_(rawText)) {
    return { ok: false, heavy: true, message: 'それは とても 大事な こと。ひとりで がまん しないで、先生か おうちの人に 直接 話してね。' };
  }
  if (isRateLimited_()) return { ok: false, message: 'いま こんざつ してるみたい。あとで ためしてね。' };
  var schema = {
    type: 'OBJECT',
    properties: {
      ok: { type: 'BOOLEAN' }, reason: { type: 'STRING' }, type: { type: 'STRING' },
      label: { type: 'STRING' }, serihu: { type: 'STRING' }, fact: { type: 'STRING' },
      take: { type: 'STRING' }, tip: { type: 'STRING' }
    },
    required: ['ok', 'type', 'label', 'serihu', 'fact', 'take', 'tip']
  };
  var r = geminiJson_(buildProposePrompt_(), [{ role: 'user', parts: [{ text: rawText }] }], schema, null);
  if (!r) return { ok: false, message: 'うまく 作れなかった。もう一回 ためしてね。' };
  if (r.ok === false) return { ok: false, message: 'それは この アプリでは あつかえないんだ。日常の ちょっとした 困りごとを 書いてね。' };
  // 構造化結果にも重い語が混ざっていないか軽く再チェック
  var joined = [r.label, r.serihu, r.fact, r.take, r.tip].join(' ');
  if (isHeavyTopic_(joined)) return { ok: false, heavy: true, message: 'それは 先生か おうちの人に 話してね。' };
  var saved = addProposal(name, rawText, {
    type: (r.type === 'seikaku' ? 'seikaku' : 'dekigoto'),
    label: String(r.label || '').slice(0, 40), serihu: String(r.serihu || '').slice(0, 200),
    fact: String(r.fact || '').slice(0, 120), take: String(r.take || '').slice(0, 120), tip: String(r.tip || '').slice(0, 120)
  });
  if (!saved.ok) return { ok: false, message: '保存に 失敗したみたい。もう一回 ためしてね。' };
  return { ok: true, message: 'ありがとう！ 先生が かくにん してから、みんなの なやみに なるよ。' };
}
