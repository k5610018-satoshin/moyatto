/**
 * モヤット — 悩みプールをスプレッドシートで管理するための補助（任意）。
 *
 * 使い方:
 *   1. installTroubleSheet() を一度だけ実行
 *        → 新しいスプレッドシートに雛形（現在の6件）が作られ、IDが実行ログに出る。
 *   2. そのIDを Config.gs の SHEET_ID に貼る。
 *   3. 以後はスプレッドシートを編集するだけで悩みを増減・修正できる（コード編集不要）。
 *
 * 列の並び: id | type | emo | label | serihu | fact | take | tip
 *   id     … 半角英数の識別子（重複させない）
 *   type   … 'seikaku'（短所・苦手）か 'dekigoto'（できごと）。モード分けに使う
 *   emo    … カードの絵文字
 *   label  … 選択カードに出す短いタイトル
 *   serihu … モヤットの弱気なセリフ
 *   fact   … 事実（ヒントパネルに表示）
 *   take   … 今のとらえ方（ここを変えてあげる対象）
 *   tip    … 考えるヒント（答えそのものは書かない）
 *
 * ⚠️ 日常のちょっとした困りごとだけ。いじめ・暴力・差別など重い話は入れない（§3 原則4）。
 */
var TROUBLE_COLUMNS = ['id', 'type', 'emo', 'label', 'serihu', 'fact', 'take', 'tip'];

function loadTroublesFromSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」が見つかりません。');

  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  var header = values[0].map(function (h) { return String(h).trim(); });
  var idx = {};
  TROUBLE_COLUMNS.forEach(function (c) { idx[c] = header.indexOf(c); });

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var id = idx.id >= 0 ? String(row[idx.id]).trim() : '';
    if (!id) continue;  // id 空行はスキップ
    var type = idx.type >= 0 ? String(row[idx.type]).trim() : '';
    out.push({
      id: id,
      type: (type === 'seikaku') ? 'seikaku' : 'dekigoto',  // 不明はできごと扱い
      emo: idx.emo >= 0 ? String(row[idx.emo]) : '🙂',
      label: idx.label >= 0 ? String(row[idx.label]) : id,
      serihu: idx.serihu >= 0 ? String(row[idx.serihu]) : '',
      fact: idx.fact >= 0 ? String(row[idx.fact]) : '',
      take: idx.take >= 0 ? String(row[idx.take]) : '',
      tip: idx.tip >= 0 ? String(row[idx.tip]) : ''
    });
  }
  return out;
}

/** 現在の DEFAULT_TROUBLES を雛形にした編集用スプレッドシートを新規作成する。 */
function installTroubleSheet() {
  var ss = SpreadsheetApp.create('モヤット 悩みプール');
  var sh = ss.getActiveSheet();
  sh.setName(SHEET_NAME);

  sh.getRange(1, 1, 1, TROUBLE_COLUMNS.length)
    .setValues([TROUBLE_COLUMNS])
    .setFontWeight('bold');

  var rows = DEFAULT_TROUBLES.map(function (t) {
    return TROUBLE_COLUMNS.map(function (c) { return t[c] || ''; });
  });
  sh.getRange(2, 1, rows.length, TROUBLE_COLUMNS.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, TROUBLE_COLUMNS.length);

  Logger.log('作成しました。SHEET_ID = ' + ss.getId());
  Logger.log('このIDを Config.gs の SHEET_ID に貼り付けてください。');
  Logger.log('URL: ' + ss.getUrl());
  return ss.getId();
}
