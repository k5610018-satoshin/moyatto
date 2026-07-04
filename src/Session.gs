/**
 * モヤット — セッションと得点（先生ダッシュボード用）。
 *
 * 先生がセッションを作成 → 参加URL（?s=コード）を配布 → 児童が名前で参加 →
 * クリアごとに得点をサーバ集計 → 先生だけが得点一覧をリアルタイム（数秒ポーリング）で見る。
 * 児童には他人の得点は見せない（§3-5「うまさを比べない」を尊重）。
 *
 * 保存先: スプレッドシート（無ければ自動作成し SESSION_SHEET_ID に保存）。
 *   sessions     … code | title | created | active
 *   participants … code | pid | name | score | joinedAt | lastActiveAt | currentTrouble
 */

// 先生用ダッシュボードの鍵。スクリプトプロパティ ADMIN_KEY があればそれを使う。
// 配布コピーでは初回設定ウィザードで ADMIN_KEY を作るため、ソースには鍵を置かない。
var DEFAULT_ADMIN_KEY = '';
var REFRAMES_HEADERS_ = ['code', 'pid', 'name', 'troubleId', 'troubleLabel', 'reframe', 'createdAt', 'reason', 'reframe1', 'reframe2', 'rid'];
function getAdminKey_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || DEFAULT_ADMIN_KEY || '';
}

/** 初回配布用: ADMIN_KEY 未設定のときだけ、先生が合言葉を決める。 */
function initializeAdminKey(newKey) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_KEY')) throw new Error('ADMIN_KEY は すでに 設定されています。');
  newKey = String(newKey || '').trim();
  if (newKey.length < 8) throw new Error('合言葉は 8文字以上にしてください。');
  if (newKey.length > 120) throw new Error('合言葉が 長すぎます。');
  props.setProperty('ADMIN_KEY', newKey);
  var base = getWebappUrl_();
  return {
    ok: true,
    teacherUrl: base ? base + '?admin=' + encodeURIComponent(newKey) : ''
  };
}

function setAdminKey(adminKey, newKey) {
  requireAdmin_(adminKey);
  newKey = String(newKey || '').trim();
  if (newKey.length < 8) throw new Error('先生用の合言葉は8文字以上にしてください。');
  if (newKey.length > 120) throw new Error('先生用の合言葉が長すぎます。');
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', newKey);
  var base = getWebappUrl_();
  return {
    ok: true,
    teacherUrl: base ? base + '?admin=' + encodeURIComponent(newKey) : ''
  };
}

function requireAdmin_(adminKey) {
  var k = getAdminKey_();
  if (!k || adminKey !== k) throw new Error('権限がありません（ADMIN_KEY）。');
}

function getSessionSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SESSION_SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 作り直す */ }
  }
  // 初回作成は二重作成（オーファン）を防ぐため、ロック＋再チェック（double-checked locking）
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    id = props.getProperty('SESSION_SHEET_ID');
    if (id) {
      try { return SpreadsheetApp.openById(id); } catch (e2) { /* 作り直す */ }
    }
    var ss = SpreadsheetApp.create('モヤット セッション記録');
    var s1 = ss.getActiveSheet(); s1.setName('sessions');
    s1.appendRow(['code', 'title', 'created', 'active']);
    var s2 = ss.insertSheet('participants');
    s2.appendRow(['code', 'pid', 'name', 'score', 'joinedAt', 'lastActiveAt', 'currentTrouble']);
    props.setProperty('SESSION_SHEET_ID', ss.getId());
    return ss;
  } finally {
    lock.releaseLock();
  }
}

function genCode_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（0,O,1,I等）を除外
  var s = '';
  for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// ===== 先生用 =====

/** セッション作成。adminKey 必須。{code, joinPath, joinUrl, teacherUrl} を返す。 */
function createSession(adminKey, title) {
  requireAdmin_(adminKey);
  var ss = getSessionSpreadsheet_();
  var code = genCode_();
  ss.getSheetByName('sessions').appendRow([code, String(title || '').slice(0, 60), new Date().toISOString(), true]);
  var base = getWebappUrl_();
  return {
    code: code,
    joinPath: '?s=' + code,
    joinUrl: base ? base + '?s=' + code : '',
    teacherUrl: base ? base + '?admin=' + encodeURIComponent(adminKey) : ''
  };
}

/** セッション一覧（新しい順）。adminKey 必須。 */
function listSessions(adminKey) {
  requireAdmin_(adminKey);
  var data = getSessionSpreadsheet_().getSheetByName('sessions').getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    out.push({ code: String(data[i][0]), title: String(data[i][1]), created: String(data[i][2]), active: data[i][3] === true });
  }
  return out.reverse();
}

/** 得点一覧（得点降順）。adminKey 必須。 */
function getLeaderboard(adminKey, code) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  var data = getSessionSpreadsheet_().getSheetByName('participants').getDataRange().getValues();
  var out = [];
  var now = Date.now();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== code) continue;
    var last = data[i][5] ? new Date(data[i][5]).getTime() : 0;
    out.push({
      name: String(data[i][2]),
      score: Number(data[i][3] || 0),
      idleSec: last ? Math.max(0, Math.round((now - last) / 1000)) : null,
      currentTrouble: String(data[i][6] || '')
    });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

/** セッションを終了/再開。adminKey 必須。 */
function setSessionActive(adminKey, code, active) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  var sh = getSessionSpreadsheet_().getSheetByName('sessions');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === code) { sh.getRange(i + 1, 4).setValue(!!active); return true; }
  }
  return false;
}

// ===== 設定（先生用ダッシュボードから） =====

/** 設定状態。鍵の値は返さず、設定済みかどうかだけ返す。adminKey 必須。 */
function getSettings(adminKey) {
  requireAdmin_(adminKey);
  var props = PropertiesService.getScriptProperties();
  return { geminiSet: !!props.getProperty('GEMINI_API_KEY'), model: MODEL, adminKeySet: !!props.getProperty('ADMIN_KEY') };
}

/** Gemini APIキーを保存。adminKey 必須。先生が管理画面から入力する。 */
function setGeminiKey(adminKey, key) {
  requireAdmin_(adminKey);
  key = String(key || '').trim();
  if (!key) throw new Error('キーが空です。');
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return { ok: true };
}

/**
 * 現在のキーで Gemini に疎通テスト。adminKey 必須。
 * ※ askMoyatto と同じリクエスト形（responseSchema + thinkingConfig）で叩くので、
 *    モデル名の誤り・思考設定の非対応・スキーマ不可なども、このテストで検出できる。
 */
function testGemini(adminKey) {
  requireAdmin_(adminKey);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'APIキーが まだ 設定されていません。' };
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(MODEL) + ':generateContent?key=' + encodeURIComponent(key);
    var body = {
      systemInstruction: { parts: [{ text: 'あなたはテスト用アシスタント。cleared=true, reply="OK" を返して。' }] },
      contents: [{ role: 'user', parts: [{ text: 'テスト' }] }],
      generationConfig: {
        temperature: TEMPERATURE,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { cleared: { type: 'BOOLEAN' }, reply: { type: 'STRING' } },
          required: ['cleared', 'reply']
        },
        thinkingConfig: thinkingConfig_()
      }
    };
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) return { ok: true, model: MODEL };
    return { ok: false, error: 'モデル「' + MODEL + '」 HTTP ' + code + ': ' + String(res.getContentText()).slice(0, 240) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** セッションのモードを先生が設定（''=児童に選ばせる / 'seikaku' / 'dekigoto'）。adminKey 必須。 */
function setSessionMode(adminKey, code, mode) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  mode = (mode === 'seikaku' || mode === 'dekigoto') ? mode : '';
  PropertiesService.getScriptProperties().setProperty('mode_' + code, mode);
  return { ok: true, mode: mode };
}

/** セッションのモードを取得（児童も呼ぶ。adminKey不要＝モード文字列のみ返す）。 */
function getSessionMode(code) {
  code = String(code || '').toUpperCase();
  if (!code) return '';
  try { return PropertiesService.getScriptProperties().getProperty('mode_' + code) || ''; } catch (e) { return ''; }
}

/** 先生ダッシュボード一括取得（モード＋得点一覧＋見方＋承認待ち）。adminKey 必須。ポーリングで使う。 */
function getDashboard(adminKey, code) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  migrateReframeRids_();
  return {
    mode: getSessionMode(code),
    leaderboard: getLeaderboard(adminKey, code),
    reframes: getReframesByTrouble(adminKey, code),
    proposals: listProposals(adminKey, 'pending'),
    voteResults: getReframeVoteResultsForAdmin_(code),
    flags: getSessionFlags_(code)
  };
}

// ===== 児童用 =====

function sessionActive_(ss, code) {
  var data = ss.getSheetByName('sessions').getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === code && data[i][3] === true) return true;
  }
  return false;
}

/** 参加。名前を登録し pid を返す。 */
function joinSession(code, name) {
  code = String(code || '').toUpperCase();
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new Error('名前を入れてね。');
  var ss = getSessionSpreadsheet_();
  if (!sessionActive_(ss, code)) throw new Error('このセッションは 見つからないよ。');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sh = ss.getSheetByName('participants');
    // 過剰なjoin（連投）でシートが肥大化しないよう簡易上限
    var data = sh.getDataRange().getValues();
    var n = 0;
    for (var i = 1; i < data.length; i++) { if (String(data[i][0]) === code) n++; }
    if (n >= 80) throw new Error('このセッションは いっぱいです。');
    var pid = Utilities.getUuid();
    var now = new Date().toISOString();
    sh.appendRow([code, pid, name, 0, now, now, '']);
    return { pid: pid, name: name };
  } finally { lock.releaseLock(); }
}

function _findParticipant(ss, code, pid) {
  var sh = ss.getSheetByName('participants');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === code && String(data[i][1]) === pid) {
      return { sheet: sh, rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function _updateParticipant(code, pid, fn) {
  code = String(code || '').toUpperCase();
  var ss = getSessionSpreadsheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var found = _findParticipant(ss, code, pid);
    if (!found) return null;   // 見つからないときは null（クライアントの数値ガードでスコアを0に潰さない）
    var result = fn(found.row);
    found.sheet.getRange(found.rowIndex, 1, 1, found.row.length).setValues([found.row]);
    return result;
  } finally { lock.releaseLock(); }
}

/** 得点+1（クリア時）。新スコアを返す（サーバが正）。 */
function addScore(code, pid) {
  return _updateParticipant(code, pid, function (row) {
    row[3] = Number(row[3] || 0) + 1;
    row[5] = new Date().toISOString();
    return Number(row[3]);
  });
}

function normalizeReframes_(reframes) {
  var arr = Array.isArray(reframes) ? reframes : String(reframes || '').split(/\s*\/\s*|\n+/);
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var s = String(arr[i] || '').trim().slice(0, 120);
    if (s && out.indexOf(s) < 0) out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

/** 取り組み中の悩みと最終活動時刻を記録（先生が「つまずき」を把握）。 */
function heartbeat(code, pid, troubleLabel) {
  return _updateParticipant(code, pid, function (row) {
    row[5] = new Date().toISOString();
    row[6] = String(troubleLabel || '').slice(0, 40);
    return Number(row[3] || 0);
  });
}

/** 自分の得点を取得（端末再読込時の復元用）。 */
function getMyScore(code, pid) {
  code = String(code || '').toUpperCase();
  var found = _findParticipant(getSessionSpreadsheet_(), code, pid);
  return found ? Number(found.row[3] || 0) : 0;
}

// ===== 見方の共有（リフレーミングのウォール） =====
// クリア時に子どもが教えてくれた「ちがう見方」を保存し、同セッションの仲間どうしで見せ合う。
// ※ うまさの採点・順位づけは一切しない（§4）。だれの見方も等価に並べる。

/** シートが無ければ作る小ヘルパー。※新規作成の競合を避けるため必ずロック内で呼ぶこと。 */
function getOrCreateSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); }
  return sh;
}

/** 既存のセッションSSを開く（無ければ null。新規作成しない＝読み取り系の副作用防止）。 */
function openSessionSpreadsheet_() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SESSION_SHEET_ID');
    if (!id) return null;
    return SpreadsheetApp.openById(id);
  } catch (e) { return null; }
}

/** reframes 既存行へ rid を一度だけ付与する。 */
function migrateReframeRids_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('RID_MIGRATED')) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    if (props.getProperty('RID_MIGRATED')) return;
    var ss = openSessionSpreadsheet_();
    if (!ss) {
      props.setProperty('RID_MIGRATED', new Date().toISOString());
      return;
    }
    var sh = ss.getSheetByName('reframes');
    if (!sh) {
      props.setProperty('RID_MIGRATED', new Date().toISOString());
      return;
    }
    sh.getRange(1, 1, 1, REFRAMES_HEADERS_.length).setValues([REFRAMES_HEADERS_]);
    var lastRow = sh.getLastRow();
    if (lastRow > 1) {
      var rows = lastRow - 1;
      var ridValues = sh.getRange(2, 11, rows, 1).getValues();
      var changed = false;
      for (var i = 0; i < ridValues.length; i++) {
        if (!ridValues[i][0]) {
          ridValues[i][0] = Utilities.getUuid();
          changed = true;
        }
      }
      if (changed) sh.getRange(2, 11, rows, 1).setValues(ridValues);
    }
    props.setProperty('RID_MIGRATED', new Date().toISOString());
  } finally {
    lock.releaseLock();
  }
}

/** クリア時に有効だった「ちがう見方」を保存（互換用）。重い語が混じれば保存しない。 */
function saveReframe(code, pid, troubleId, troubleLabel, reframe) {
  code = String(code || '').toUpperCase();
  reframe = String(reframe || '').trim().slice(0, 200);
  if (!reframe || !code) return { ok: false };
  if (isHeavyTopic_(reframe)) return { ok: false };   // Code.gs の安全ガードを流用
  try {
    var ss = getSessionSpreadsheet_();
    var name = '';
    var found = pid ? _findParticipant(ss, code, pid) : null;
    if (found) name = String(found.row[2] || '');
    var lock = LockService.getScriptLock(); lock.waitLock(5000);
    try {
      var sh = getOrCreateSheet_(ss, 'reframes', REFRAMES_HEADERS_);
      sh.appendRow([code, String(pid || ''), name.slice(0, 20), String(troubleId || '').slice(0, 40),
        String(troubleLabel || '').slice(0, 40), reframe, new Date().toISOString(), '', reframe, '', Utilities.getUuid()]);
    } finally { lock.releaseLock(); }
    return { ok: true };
  } catch (e) { return { ok: false }; }
}

/**
 * クリア確定: 加点と履歴保存を一体化する。同じ pid+troubleId は二重加点しない。
 * 返り値 = {ok, score, duplicate?}
 */
function completeReframe(code, pid, troubleId, troubleLabel, reframes, reason) {
  code = String(code || '').toUpperCase();
  pid = String(pid || '');
  troubleId = String(troubleId || '').slice(0, 40);
  var arr = normalizeReframes_(reframes);
  reason = String(reason || '').trim().slice(0, 240);
  if (!code || !pid || !troubleId || arr.length < 2) return { ok: false };
  if (isHeavyTopic_(arr.join(' ') + ' ' + reason)) return { ok: false };
  var ss = getSessionSpreadsheet_();
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var found = _findParticipant(ss, code, pid);
    if (!found) return { ok: false };
    var sh = getOrCreateSheet_(ss, 'reframes', REFRAMES_HEADERS_);
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === code && String(data[i][1]) === pid && String(data[i][3]) === troubleId) {
        return { ok: true, score: Number(found.row[3] || 0), duplicate: true };
      }
    }
    found.row[3] = Number(found.row[3] || 0) + 1;
    found.row[5] = new Date().toISOString();
    found.sheet.getRange(found.rowIndex, 1, 1, found.row.length).setValues([found.row]);
    sh.appendRow([
      code, pid, String(found.row[2] || '').slice(0, 20), troubleId,
      String(troubleLabel || '').slice(0, 40), arr.join(' / '), new Date().toISOString(),
      reason, arr[0] || '', arr[1] || '', Utilities.getUuid()
    ]);
    return { ok: true, score: Number(found.row[3] || 0), duplicate: false };
  } finally { lock.releaseLock(); }
}

/** 児童ウォール: 同セッション・同じ悩みの「他の参加者」の見方を匿名で新しい順に最大limit件。 */
function getWall(code, excludePid, limit, troubleId) {
  code = String(code || '').toUpperCase();
  troubleId = String(troubleId || '').slice(0, 40);
  limit = Math.min(Math.max(parseInt(limit || 10, 10) || 10, 1), 30);
  try {
    var ss = openSessionSpreadsheet_(); if (!ss) return [];
    var sh = ss.getSheetByName('reframes');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    var out = [];
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) !== code) continue;
      if (excludePid && String(data[i][1]) === String(excludePid)) continue;
      if (troubleId && String(data[i][3]) !== troubleId) continue;
      out.push({
        name: '',
        troubleLabel: String(data[i][4] || ''),
        reframe: String(data[i][5] || ''),
        reason: String(data[i][7] || ''),
        reframe1: String(data[i][8] || ''),
        reframe2: String(data[i][9] || '')
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) { return []; }
}

/** 児童本人のスッキリ履歴。 */
function getMyHistory(code, pid, limit) {
  code = String(code || '').toUpperCase();
  pid = String(pid || '');
  limit = Math.min(Math.max(parseInt(limit || 20, 10) || 20, 1), 50);
  if (!code || !pid) return [];
  try {
    var ss = openSessionSpreadsheet_(); if (!ss) return [];
    var sh = ss.getSheetByName('reframes'); if (!sh) return [];
    var data = sh.getDataRange().getValues();
    var out = [];
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) !== code || String(data[i][1]) !== pid) continue;
      out.push({
        troubleId: String(data[i][3] || ''),
        troubleLabel: String(data[i][4] || ''),
        reframe: String(data[i][5] || ''),
        createdAt: String(data[i][6] || ''),
        reason: String(data[i][7] || ''),
        reframe1: String(data[i][8] || ''),
        reframe2: String(data[i][9] || '')
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) { return []; }
}

/** 先生用: 悩み別に「誰がどう言い換えてクリアしたか」（TV投影用）。adminKey 必須。 */
function getReframesByTrouble(adminKey, code) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  var groups = {}, order = [];
  try {
    var ss = openSessionSpreadsheet_(); if (!ss) return [];
    var sh = ss.getSheetByName('reframes');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) !== code) continue;
      var label = String(data[i][4] || '(その他)');
      if (!groups[label]) { groups[label] = []; order.push(label); }
      groups[label].push({ name: String(data[i][2] || 'ともだち'), reframe: String(data[i][5] || ''), at: String(data[i][6] || '') });
    }
  } catch (e) { return []; }
  var out = order.map(function (k) { return { troubleLabel: k, items: groups[k] }; });
  out.sort(function (a, b) { return b.items.length - a.items.length; });
  return out;
}

// ===== 参加者の悩み追加（AI構造化 → 先生承認 → プールに合流） =====

/** 構造化済みの提案を pending で保存（Code.gs proposeTrouble から呼ぶ）。 */
function addProposal(name, rawText, structured) {
  try {
    var ss = getSessionSpreadsheet_();
    var id = 'usr_' + Utilities.getUuid().slice(0, 8);
    var lock = LockService.getScriptLock(); lock.waitLock(5000);
    try {
      var sh = getOrCreateSheet_(ss, 'proposals',
        ['id', 'name', 'rawText', 'label', 'serihu', 'fact', 'take', 'tip', 'type', 'status', 'createdAt']);
      var data = sh.getDataRange().getValues();
      var pending = 0;
      for (var i = 1; i < data.length; i++) { if (String(data[i][9]) === 'pending') pending++; }
      if (pending >= 60) throw new Error('いまは いっぱいです。');
      sh.appendRow([id, String(name || '').slice(0, 20), String(rawText || '').slice(0, 200),
        structured.label, structured.serihu, structured.fact, structured.take, structured.tip,
        structured.type, 'pending', new Date().toISOString()]);
    } finally { lock.releaseLock(); }
    return { ok: true, id: id };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** 提案一覧（既定: pending を新しい順）。adminKey 必須。 */
function listProposals(adminKey, status) {
  requireAdmin_(adminKey);
  status = status || 'pending';
  var out = [];
  try {
    var sh = getSessionSpreadsheet_().getSheetByName('proposals');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (status !== 'all' && String(data[i][9]) !== status) continue;
      out.push({
        id: String(data[i][0]), name: String(data[i][1]), rawText: String(data[i][2]),
        label: String(data[i][3]), serihu: String(data[i][4]), fact: String(data[i][5]),
        take: String(data[i][6]), tip: String(data[i][7]), type: String(data[i][8]),
        status: String(data[i][9]), createdAt: String(data[i][10])
      });
    }
  } catch (e) { return []; }
  return out.reverse();
}

/** 提案の状態変更（approved/rejected/pending）。adminKey 必須。承認時はプールのキャッシュを破棄。 */
function setProposalStatus(adminKey, id, status) {
  requireAdmin_(adminKey);
  if (['approved', 'rejected', 'pending'].indexOf(status) < 0) throw new Error('bad status');
  var sh = getSessionSpreadsheet_().getSheetByName('proposals');
  if (!sh) return false;
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === id) {
        sh.getRange(i + 1, 10).setValue(status);
        try { CacheService.getScriptCache().remove('approved_troubles'); } catch (e) {}
        return true;
      }
    }
  } finally { lock.releaseLock(); }
  return false;
}

/**
 * 承認済みの追加悩みを悩みプール形式で返す（Config.gs getTroubles_ がマージ）。
 * ⚠️ ここでは絶対にスプレッドシートを「新規作成しない」（単体利用の児童ページ表示で空シートを生まないため）。
 * SESSION_SHEET_ID が無ければ即 []。30秒キャッシュで doGet ごとのシート読みを抑える。
 */
function getApprovedExtraTroubles_() {
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get('approved_troubles');
    if (cached) return JSON.parse(cached);
    var id = PropertiesService.getScriptProperties().getProperty('SESSION_SHEET_ID');
    if (!id) return [];
    var sh = SpreadsheetApp.openById(id).getSheetByName('proposals');
    if (!sh) return [];
    var data = sh.getDataRange().getValues();
    var out = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][9]) !== 'approved') continue;
      out.push({
        id: String(data[i][0]),
        type: (String(data[i][8]) === 'seikaku' ? 'seikaku' : 'dekigoto'),
        emo: '🌱',
        label: String(data[i][3]), serihu: String(data[i][4]),
        fact: String(data[i][5]), take: String(data[i][6]), tip: String(data[i][7])
      });
    }
    cache.put('approved_troubles', JSON.stringify(out), 30);
    return out;
  } catch (e) { return []; }
}
