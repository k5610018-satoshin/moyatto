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
var RATE_PER_MIN = 600;       // 全体で1分あたりの上限呼び出し回数（超過は静かにフォールバック）。30人同時授業でも届かない値にしつつ、ボット的な濫用は止める

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
  tpl.troublesJson = safeJson_(publicTroubles_(getTroubles_()));
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
    return jsonOutput_(setAiKey(adminKey, key));
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

/** 児童画面に渡すお題から、判定用の見方（内部基準）を外す。判定とヒントはサーバー側の一覧を使う。 */
function publicTroubles_(list) {
  return (list || []).map(function (t) {
    var card = {};
    Object.keys(t || {}).forEach(function (key) {
      if (key !== 'reframes') card[key] = t[key];
    });
    return card;
  });
}

/** 児童画面から届いた「すでに認めた見方」を、判定の材料として安全な形にそろえる。 */
function cleanAccepted_(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (s) {
    var text = String(s || '').trim().slice(0, 120);
    if (text && !isHeavyTopic_(text) && out.indexOf(text) < 0 && out.length < 2) out.push(text);
  });
  return out;
}

/**
 * 会話が長くなって最初の見方が判定に届かなくても、一度認めた見方は取り消さない。
 * クリアの判定そのものは AI の結果に従う（ここでは進み具合を下げないことだけを守る）。
 */
function keepAcceptedProgress_(result, previous) {
  if (!result || result.support || result.retryable || result.cleared || !previous.length) return result;
  if (result.progress >= previous.length) return result;
  return result_(false, previous.length, previous.slice(0, 1), '', result.reply);
}

/**
 * クライアントから呼ばれるサーバ関数。
 * payload = { troubleId: string, messages: [{ role:'user'|'model', text:string }, ...], acceptedReframes?: string[] }
 * 返り値   = { cleared: boolean, progress: 0|1|2, acceptedReframes: string[], reason: string, reply: string }
 *            相談に切り替えたときは support: true、もう一度送ってほしいときは retryable: true が付く。
 */
function askMoyatto(payload) {
  payload = payload || {};
  var trouble = findTrouble_(payload.troubleId);
  var previous = cleanAccepted_(payload.acceptedReframes);
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
    return adultSupport_();
  }

  // 同じカードで後から別の回答を送った場合も、相談に切り替えた発言を外部へ再送しない。
  for (var i = contents.length - 2; i >= 0; i--) {
    if (contents[i].role === 'user' && isHeavyTopic_(contents[i].parts[0].text)) {
      contents = dropLeadingModelTurns_(contents.slice(i + 1));
      break;
    }
  }

  // 軽量ヒューリスティック（初手のみ）: 明らかに浅い返事は Gemini に渡さず、ヒントを添えて聞き返す。
  // ※「3回でやさしく受け取る」を壊さないよう、最初の一手だけに限定する。迷うものは Gemini に委ねる。
  if (contents.length <= 1) {
    var quick = obviouslyShallow_(lastUser, trouble);
    if (quick) return { cleared: false, reply: quick };
  }

  // AIキー未設定のときは、誤解を生む「聞き返し」や偽の「解決」でなく、先生に分かる明確な案内を返す。
  if (!hasApiKey_() && !isTrialActive_()) {
    return result_(false, 0, [], '', '先生が AIの じゅんびを しているよ。先生に つたえてね。');
  }

  // 全体レート制限（超過時は静かにフォールバック＝授業を止めない）
  if (isRateLimited_()) {
    return friendlyFallback_();
  }

  var judged = callGemini_(buildSystemPrompt_(trouble, previous), labelJudgementContents_(contents));
  return keepAcceptedProgress_(judged, previous);
}

function result_(cleared, progress, acceptedReframes, reason, reply) {
  progress = Math.max(0, Math.min(2, Number(progress || 0)));
  var arr = Array.isArray(acceptedReframes) ? acceptedReframes : [];
  var seen = Object.create(null);
  arr = arr.map(function (s) { return String(s || '').trim().slice(0, 120); })
    .filter(function (s) {
      var key = s.normalize('NFKC').replace(/\s+/g, '').replace(/[。.!?、]+$/g, '');
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    })
    .slice(0, 2);
  if (arr.length === 2 && (cleared !== true || progress !== 2)) {
    return friendlyFallback_();
  }
  if (arr.length > progress) progress = arr.length;
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

/**
 * 重い話題の軽量ガード（完全ではないが、明白なものを拾う安全ネット）。
 * モヤットへのアドバイスにも出てくる言葉（「むしされた わけじゃない」「たすけられた」など）は
 * ここでは拾わず、判定AIの concern に任せる。ここには取りちがえにくい言い方だけを置く。
 */
function isHeavyTopic_(text) {
  if (!text) return false;
  var t = String(text).normalize('NFKC').replace(/\s/g, '');
  if (/(?:毎日|まいにち|何度も|なんども|いつも|何回も|ずっと|毎回|まいかい|何日も|なんにちも).{0,22}(?:無視され|むしされ|からかわれ|仲間はずれ|仲間外れ|なかまはずれ|笑われ|ばかにされ|バカにされ|悪口|わるぐち|いじわるされ|意地悪され)/.test(t)) return true;
  if (/(?:を|に|で|から)(?:けられ|蹴られ)/.test(t)) return true;
  if (/(?:お金|おかね|おこづかい|お小遣い)を?(?:とられ|取られ|盗まれ|ぬすまれ)/.test(t)) return true;
  if (/(?:くつ|靴|うわばき|上ばき|上履き|ふでばこ|筆箱|筆入れ|教科書|きょうかしょ|持ち物|もちもの)を?(?:かくされ|隠され|すてられ|捨てられ)/.test(t)) return true;
  if (/(?:家|いえ|うち)に(?:帰りたくない|かえりたくない)/.test(t)) return true;
  if (/(?:ご飯|ごはん)を?(?:もらえない|食べさせてもらえない|たべさせてもらえない)/.test(t)) return true;
  var deny = [
    '死にたい', 'しにたい', '消えたい', 'きえたい', '消えてしまいたい', 'いなくなりたい', '死んだほうがいい', 'しんだほうがいい',
    '死ね', 'しねって', 'しねと言', '殺す', '殺し', 'ころして', 'ころされ',
    'リストカット', 'リスカ', '自殺', 'じさつ',
    'いじめられ', 'いじめてくる', '殴られ', 'なぐられ', '殴る', '蹴られ', '蹴って', 'たたかれ', '叩かれ', 'ぶたれ',
    'つねられ', 'おどされ', '脅され',
    'さわられ', '触られ', '虐待', 'ぎゃくたい', 'いじめら', 'いじめにあ', 'やめてと言ってもやめてくれない'
  ];
  for (var i = 0; i < deny.length; i++) {
    if (t.indexOf(deny[i]) !== -1) return true;
  }
  return false;
}

/**
 * 全体で1分あたりの呼び出し回数を制限する（匿名公開時の濫用抑制）。失敗時は通す。
 * ※ 以前はここで ScriptLock を取っていたが、30人同時アクセス時に全リクエストが
 *    ロック待ちで直列化して「渋滞」の原因になったため、ロックなしで運用する。
 *    競合でカウントが数件ズレても、桁違いの濫用を止める目的には影響しない。
 */
function isRateLimited_() {
  try {
    var cache = CacheService.getScriptCache();
    var bucket = 'rl_' + Math.floor(Date.now() / 60000);
    var n = parseInt(cache.get(bucket) || '0', 10) + 1;
    cache.put(bucket, String(n), 90);  // 90秒で自然消滅
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
  if (getAiProvider_() === 'openai') return callOpenAi_(systemText, contents);
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
          reply: { type: 'STRING' },
          concern: { type: 'BOOLEAN' }
        },
        required: ['cleared', 'progress', 'acceptedReframes', 'reason', 'reply', 'concern']
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
    var res = geminiRequest_(body);
    if (res.getResponseCode() !== 200) {
      return friendlyFallback_();
    }
    var data = JSON.parse(res.getContentText());
    // Gemini 3.x は思考の part が混ざることがあるので、text を持つ part を探す
    var cand = data.candidates && data.candidates[0];
    if ((data.promptFeedback && data.promptFeedback.blockReason) ||
        (cand && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].indexOf(cand.finishReason) >= 0)) {
      return adultSupport_();
    }
    var parts = cand && cand.content && cand.content.parts;
    var text = '';
    if (parts) {
      for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi] && typeof parts[pi].text === 'string' && parts[pi].text) { text = parts[pi].text; break; }
      }
    }
    if (!text) {
      return friendlyFallback_();
    }
    return parseResult_(text);
  } catch (e) {
    return friendlyFallback_();
  }
}

/** モデル出力（JSON文字列）を構造化判定に変換。万一の崩れにも耐える。 */
function parseResult_(text) {
  var clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    var obj = JSON.parse(clean);
    // 児童本人のつらさや被害の訴えとAIが判断したら、判定せずに大人へつなぐ。
    if (obj && obj.concern === true) return adultSupport_();
    return result_(
      obj.cleared === true,
      obj.progress,
      obj.acceptedReframes,
      obj.reason,
      (typeof obj.reply === 'string' && obj.reply.trim()) ? obj.reply.trim() : 'ありがとう。もう一つ、ちがう見方も 探してみよう。'
    );
  } catch (e) {
    return friendlyFallback_();
  }
}

/** 判定できなかったときは、回答と前回の進み具合を画面に残す。 */
function friendlyFallback_() {
  var result = result_(false, 0, [], '', '今は 判定できなかったよ。書いた文のまま、もう一度 おくってね。');
  result.retryable = true;
  return result;
}

function adultSupport_() {
  var result = result_(false, 0, [], '', 'それは、とっても 大事な こと。ひとりで がまん しないでね。おうちの人か 先生に、お話 してみて。');
  result.support = true;
  return result;
}

/**
 * 明らかに浅い初手だけを、Gemini に渡す前に拾う軽量ヒューリスティック。
 * 返り値: 聞き返し用の文字列（拾ったとき）/ '' （AIに任せるとき）。
 * 迷ったら '' を返し、判断は Gemini に委ねる（過剰検出で良い見方を弾かないため）。
 */
function obviouslyShallow_(text, trouble) {
  var t = String(text || '').trim();
  if (!t) return '';
  var standalone = t.normalize('NFKC').replace(/[\s。、，,！!？?「」『』…~〜]+/g, '');
  var skip = ['気にしないで', 'きにしないで', '気にするな', 'きにするな', 'わすれて', '忘れて', 'どんまい', 'ドンマイ'];
  for (var i = 0; i < skip.length; i++) {
    if (standalone === skip[i]) {
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
function geminiJson_(systemText, contents, schema, fallback, blocked) {
  if (getAiProvider_() === 'openai') return openAiJson_(systemText, contents, schema, fallback, blocked);
  try {
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
    var res = geminiRequest_(body);
    if (res.getResponseCode() !== 200) return fallback;
    var data = JSON.parse(res.getContentText());
    var cand = data.candidates && data.candidates[0];
    if ((data.promptFeedback && data.promptFeedback.blockReason) ||
        (cand && /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST)$/.test(cand.finishReason))) return blocked || fallback;
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
 * このカードで送信した発言だけを読む。相談に切り替えた発言より前は再利用しない。
 * 児童の下書き・名前・クラス情報は受け取らない。
 */
function hintContext_(request) {
  var messages = Array.isArray(request.messages) ? request.messages.slice(-MAX_MESSAGES) : [];
  var answers = [], replies = [], support = false, reset = false;
  messages.forEach(function(m) {
    if (!m || typeof m.text !== 'string') return;
    var text = m.text.trim().slice(0, MAX_TEXT_LEN);
    if (!text) return;
    if (m.role === 'user') {
      support = isHeavyTopic_(text);
      if (support) { answers = []; replies = []; reset = true; }
      else answers.push(text);
    } else if (!support && (m.role === 'model' || m.role === 'assistant') && !isHeavyTopic_(text)) {
      replies.push(text);
    }
  });
  var shown = Array.isArray(request.shownHints) ? request.shownHints.slice(-3) : [];
  var accepted = Array.isArray(request.acceptedReframes) ? request.acceptedReframes.slice(0, 2) : [];
  return {
    answers: answers.slice(-6),
    replies: replies.slice(-2),
    accepted: reset ? [] : accepted.filter(function(s) { return typeof s === 'string' && !isHeavyTopic_(s); })
      .map(function(s) { return s.slice(0, 120); }),
    shown: reset ? [] : shown.filter(function(h) { return h && typeof h.hint === 'string' && !isHeavyTopic_(h.hint); })
      .map(function(h) { return { angle: String(h.angle || '').slice(0, 24), hint: h.hint.slice(0, 160) }; }),
    index: Math.max(1, Math.min(3, Number(request.hintIndex || request.hintCount) || 1)),
    support: support
  };
}

function hintWords_(text) {
  return String(text || '').normalize('NFKC').replace(/^ヒント\s*[:：]?\s*/, '')
    .replace(/[\s、。!?！？「」『』・…〜~]/g, '').toLowerCase();
}

/** 表記や語尾だけを変えた問いはもう一度表示しない。 */
function similarHint_(a, b) {
  var x = hintWords_(a), y = hintWords_(b);
  if (!x || !y) return false;
  if (x === y || (Math.min(x.length, y.length) >= 5 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0))) return true;
  if (Math.min(x.length, y.length) < 8) return false;
  function pairs(s) {
    var grams = new Set();
    for (var i = 1; i < s.length; i++) grams.add(s.slice(i - 1, i + 1));
    return grams;
  }
  var left = pairs(x), right = pairs(y), both = 0;
  left.forEach(function(g) { if (right.has(g)) both++; });
  return 2 * both / (left.size + right.size) >= 0.74;
}

/** 例文を渡す前に問いの角度を選ぶ。教師の正解例はヒント生成に使わない。 */
function chooseHint_(t, c) {
  var isTrait = t.type === 'seikaku';
  var bank = {
    notice: 'お話の中で、たしかに起きたと言えるのは、どの部分かな？',
    meaning: '起きたことから、モヤットはどんなことまで思ったのかな？',
    anchor: 'その言葉をかけたくなったのは、お話のどこを読んだからかな？',
    scope: 'この一場面から言えることは、どこまでかな？',
    friend: '同じことを友だちが話したら、その子のことをどんなふうに見るかな？',
    situation: isTrait ? '場所や相手が変わると、同じふるまいはどう見えるかな？' : 'その場にいた別の人には、どんなふうに見えたかもしれない？',
    value: 'モヤットが大事にしたかったことに目を向けると、何が見えるかな？',
    learning: 'あとでこの場面をふり返ったら、どんな手がかりが見つかりそう？',
    agency: 'モヤットが自分で選べることに目を向けると、どう見えるかな？'
  };
  if (t.id === 'test' && /テスト|点数|答案/.test(t.fact)) {
    bank.notice = '答案を見て、たしかに分かることは何かな？';
    bank.anchor = '点数以外に、答案のどこをいっしょに見てあげたい？';
    bank.scope = '今回の点だけで、モヤットについてどこまで分かるかな？';
    bank.learning = 'あとで答案を見返すと、どんなことに気づけそう？';
    bank.friend = '友だちが同じ点を取ったら、その子のことをどう思うかな？';
  }
  var last = c.answers[c.answers.length - 1] || '';
  var words = hintWords_(last);
  var used = c.accepted.join(' ') + ' ' + last;
  var order;
  if (!last) {
    order = isTrait ? ['situation', 'value', 'notice'] : ['meaning', 'notice', 'friend'];
  } else if (/^(わからない|分からない|思いつかない|むずかしい|難しい|うーん|わかんない|分かんない)$/.test(words)) {
    order = ['notice', 'friend', 'meaning'];
  } else if (last && /^(どんまい|ドンマイ|大丈夫|だいじょうぶ|がんばれ|頑張れ|気にしないで|きにしないで)$/.test(words)) {
    order = ['anchor', 'friend', 'meaning'];
  } else if (last && words === hintWords_(t.fact)) {
    order = ['meaning', 'friend', 'scope'];
  } else if (/練習|れんしゅう|次に|つぎに|つまず|まちがえた所|直す|なおす|準備|じゅんび|見直/.test(used)) {
    order = ['scope', 'value', 'friend'];
  } else if (/決まら|きまら|だけ|全部|ぜんぶ|一回|1回|いっかい/.test(used)) {
    order = ['learning', 'situation', 'value'];
  } else if (/かもしれ|かも|予定|都合|聞こえ/.test(used)) {
    order = ['value', 'scope', 'agency'];
  } else if (c.accepted.length) {
    order = ['situation', 'value', 'scope'];
  } else if (isTrait) {
    order = ['situation', 'value', 'scope'];
  } else {
    order = ['notice', 'scope', 'friend'];
  }
  var keys = order.concat(Object.keys(bank).filter(function(k) { return order.indexOf(k) < 0; }));
  var allIdeas = c.accepted.concat(c.answers).join(' ');
  var covered = {
    learning: /練習|れんしゅう|つまず|見直|直すところ|なおすところ/.test(allIdeas),
    scope: /決まら|きまら|だけで|一回だけ|いっかいだけ/.test(allIdeas),
    situation: /予定|都合|急いで|いそいで|聞こえな|きこえな/.test(allIdeas)
  };
  var usedText = [t.tip].concat(c.replies, c.shown.map(function(h) { return h.hint; }));
  keys = keys.filter(function(k) {
    return !covered[k] && !c.shown.some(function(h) { return h.angle === k; }) &&
      !usedText.some(function(s) { return similarHint_(s, bank[k]); });
  });
  // 従来のクライアントが回数だけを送る場合も、次の問いへ進める。
  var offset = c.shown.length ? 0 : Math.floor(c.index) - 1;
  var angle = keys[Math.min(offset, keys.length - 1)];
  return angle ? { angle: angle, hint: bank[angle] } : null;
}

function moreHint(request) {
  request = request || {};
  var t = findTrouble_(request.troubleId);
  if (!t) return { retryable: true, message: 'お題を開き直してみてね。' };
  var c = hintContext_(request);
  if (c.support) return { support: true, message: adultSupport_().reply };
  var choice = chooseHint_(t, c);
  if (!choice) return { retryable: true, message: 'ここまでのヒントを見返してみてね。' };
  if (!c.answers.length || (!hasApiKey_() && !isTrialActive_()) || isRateLimited_()) return choice;
  var schema = { type: 'OBJECT', properties: {
    hint: { type: 'STRING' }, needsAdult: { type: 'BOOLEAN' }
  }, required: ['hint', 'needsAdult'] };
  var context = { answers: c.answers, accepted: c.accepted, recentReplies: c.replies,
    earlierHints: [t.tip].concat(c.shown.map(function(h) { return h.hint; })), nextQuestion: choice.hint };
  var reply = geminiJson_(buildHintPrompt_(t), [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }], schema, null, { hint: '', needsAdult: true });
  if (reply && reply.needsAdult === true) return { support: true, message: adultSupport_().reply };
  if (!reply || reply.needsAdult !== false || typeof reply.hint !== 'string') return choice;
  var hint = reply.hint.trim().replace(/^ヒント\s*[:：]\s*/, '');
  var duplicate = context.earlierHints.concat(c.replies).some(function(s) {
    return similarHint_(s, hint);
  });
  if (hint.length < 5 || hint.length > 100 || !/^[^?？\n]+[?？]$/.test(hint) || duplicate || isHeavyTopic_(hint)) return choice;
  return { angle: choice.angle, hint: hint };
}
/**
 * 参加者の悩み追加: 子どもが書いた困りごとを Gemini で悩みカードに構造化し、
 * 安全判定の上で「先生承認待ち（pending）」として保存する（Session.gs addProposal_）。
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
  var saved = addProposal_(name, rawText, {
    type: (r.type === 'seikaku' ? 'seikaku' : 'dekigoto'),
    label: String(r.label || '').slice(0, 40), serihu: String(r.serihu || '').slice(0, 200),
    fact: String(r.fact || '').slice(0, 120), take: String(r.take || '').slice(0, 120), tip: String(r.tip || '').slice(0, 120)
  });
  if (!saved.ok) return { ok: false, message: '保存に 失敗したみたい。もう一回 ためしてね。' };
  return { ok: true, message: 'ありがとう！ 先生が かくにん してから、みんなの なやみに なるよ。' };
}
