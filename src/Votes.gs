/**
 * みんなの見方への「いいな」投票。
 * 得点やランキングとは切り離し、読み合いのきっかけとして扱う。
 */

var VOTES_HEADERS_ = ['code', 'voterPid', 'voterName', 'targetRid', 'targetPid', 'targetName', 'troubleId', 'troubleLabel', 'reframe', 'createdAt'];

function defaultSessionFlags_() {
  // 名前は既定で匿名。先生画面の「名前を表示」でONにしたセッションだけ表示する。
  return { reveal: false, showNames: false };
}

function getSessionFlags_(code) {
  code = String(code || '').toUpperCase();
  var base = defaultSessionFlags_();
  if (!code) return base;
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('flags_' + code);
    if (!raw) return base;
    var saved = JSON.parse(raw);
    return {
      reveal: !!(saved && saved.reveal === true),
      showNames: !!(saved && saved.showNames === true)
    };
  } catch (e) {
    return base;
  }
}

function setSessionFlags(adminKey, code, flags) {
  requireAdmin_(adminKey);
  code = String(code || '').toUpperCase();
  if (!code) throw new Error('セッションを 選んでください。');
  var cur = getSessionFlags_(code);
  flags = flags || {};
  if (Object.prototype.hasOwnProperty.call(flags, 'reveal')) cur.reveal = flags.reveal === true;
  if (Object.prototype.hasOwnProperty.call(flags, 'showNames')) cur.showNames = flags.showNames === true;
  PropertiesService.getScriptProperties().setProperty('flags_' + code, JSON.stringify(cur));
  return cur;
}

function getSessionState(code) {
  code = String(code || '').toUpperCase();
  var flags = getSessionFlags_(code);
  return {
    mode: getSessionMode(code),
    reveal: flags.reveal,
    showNames: flags.showNames
  };
}

function getClassReframes(code, pid) {
  code = String(code || '').toUpperCase();
  pid = String(pid || '');
  if (!code) return [];
  var ss = openSessionSpreadsheet_();
  if (!ss) return [];
  var flags = getSessionFlags_(code);
  var reframes = readReframesForCode_(ss, code);
  var votes = readVotesForCode_(ss, code);
  var voteCounts = {};
  var votedByMe = {};
  for (var i = 0; i < votes.length; i++) {
    voteCounts[votes[i].targetRid] = (voteCounts[votes[i].targetRid] || 0) + 1;
    if (votes[i].voterPid === pid) votedByMe[votes[i].targetRid] = true;
  }
  reframes.sort(function (a, b) {
    return dateMillis_(b.createdAt) - dateMillis_(a.createdAt);
  });
  return reframes.map(function (r) {
    return {
      rid: r.rid,
      troubleId: r.troubleId,
      troubleLabel: r.troubleLabel,
      reframe: r.reframe,
      reframe1: r.reframe1,
      reframe2: r.reframe2,
      name: flags.showNames ? r.name : '',
      pid: r.pid,
      mine: pid && r.pid === pid,
      voteCount: voteCounts[r.rid] || 0,
      votedByMe: votedByMe[r.rid] === true
    };
  });
}

function saveReframeVotes(code, voterPid, targetRids) {
  code = String(code || '').toUpperCase();
  voterPid = String(voterPid || '');
  if (!code || !voterPid) throw new Error('もう一回 さんか してから えらんでね。');
  var clean = normalizeTargetRids_(targetRids);
  if (clean.length > 3) throw new Error('えらべるのは 3つまでだよ。');

  var ss = getSessionSpreadsheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var found = _findParticipant(ss, code, voterPid);
    if (!found) throw new Error('もう一回 さんか してから えらんでね。');
    var voterName = String(found.row[2] || '').slice(0, 20);
    var byRid = {};
    var reframes = readReframesForCode_(ss, code);
    for (var i = 0; i < reframes.length; i++) byRid[reframes[i].rid] = reframes[i];
    for (var j = 0; j < clean.length; j++) {
      var target = byRid[clean[j]];
      if (!target) throw new Error('見方が 見つかりません。もう一回 読みこんでね。');
      if (target.pid === voterPid) throw new Error('自分の 見方には えらべません。');
    }

    var sh = getOrCreateSheet_(ss, 'reframe_votes', VOTES_HEADERS_);
    var data = sh.getDataRange().getValues();
    for (var row = data.length - 1; row >= 1; row--) {
      if (String(data[row][0]) === code && String(data[row][1]) === voterPid) {
        sh.deleteRow(row + 1);
      }
    }
    var now = new Date().toISOString();
    for (var k = 0; k < clean.length; k++) {
      var t = byRid[clean[k]];
      sh.appendRow([
        code, voterPid, voterName, t.rid, t.pid, t.name, t.troubleId,
        t.troubleLabel, t.reframe, now
      ]);
    }
    return { ok: true, saved: clean.length };
  } finally {
    lock.releaseLock();
  }
}

function getReframeVoteResults(code) {
  code = String(code || '').toUpperCase();
  var flags = getSessionFlags_(code);
  if (!flags.reveal) return { revealed: false, items: [], showNames: flags.showNames };
  return {
    revealed: true,
    showNames: flags.showNames,
    items: buildVoteResults_(code, false, true)
  };
}

function getReframeVoteResultsForAdmin_(code) {
  return buildVoteResults_(String(code || '').toUpperCase(), true, false);
}

function normalizeTargetRids_(targetRids) {
  var raw = Array.isArray(targetRids) ? targetRids : (targetRids ? [targetRids] : []);
  var seen = {};
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var rid = String(raw[i] || '').trim();
    if (!rid || seen[rid]) continue;
    seen[rid] = true;
    out.push(rid);
  }
  return out;
}

function readReframesForCode_(ss, code) {
  var sh = ss && ss.getSheetByName('reframes');
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== code) continue;
    var rid = String(data[i][10] || '');
    if (!rid) continue;
    out.push({
      rid: rid,
      code: String(data[i][0] || ''),
      pid: String(data[i][1] || ''),
      name: String(data[i][2] || 'ともだち'),
      troubleId: String(data[i][3] || ''),
      troubleLabel: String(data[i][4] || '(その他)'),
      reframe: String(data[i][5] || ''),
      createdAt: String(data[i][6] || ''),
      reason: String(data[i][7] || ''),
      reframe1: String(data[i][8] || ''),
      reframe2: String(data[i][9] || '')
    });
  }
  return out;
}

function readVotesForCode_(ss, code) {
  var sh = ss && ss.getSheetByName('reframe_votes');
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== code) continue;
    out.push({
      code: String(data[i][0] || ''),
      voterPid: String(data[i][1] || ''),
      voterName: String(data[i][2] || ''),
      targetRid: String(data[i][3] || ''),
      targetPid: String(data[i][4] || ''),
      targetName: String(data[i][5] || ''),
      troubleId: String(data[i][6] || ''),
      troubleLabel: String(data[i][7] || ''),
      reframe: String(data[i][8] || ''),
      createdAt: String(data[i][9] || '')
    });
  }
  return out;
}

function buildVoteResults_(code, includeVoters, respectShowNames) {
  if (!code) return [];
  var ss = openSessionSpreadsheet_();
  if (!ss) return [];
  var flags = getSessionFlags_(code);
  var showNames = respectShowNames ? flags.showNames : true;
  var reframes = readReframesForCode_(ss, code);
  var byRid = {};
  for (var i = 0; i < reframes.length; i++) byRid[reframes[i].rid] = reframes[i];
  var votes = readVotesForCode_(ss, code);
  var map = {};
  for (var j = 0; j < votes.length; j++) {
    var v = votes[j];
    if (!v.targetRid) continue;
    var base = byRid[v.targetRid] || {
      rid: v.targetRid,
      name: v.targetName,
      troubleId: v.troubleId,
      troubleLabel: v.troubleLabel,
      reframe: v.reframe,
      createdAt: v.createdAt,
      reframe1: '',
      reframe2: ''
    };
    if (!map[v.targetRid]) {
      map[v.targetRid] = {
        rid: v.targetRid,
        votes: 0,
        name: showNames ? String(base.name || v.targetName || '') : '',
        troubleLabel: String(base.troubleLabel || v.troubleLabel || ''),
        reframe: String(base.reframe || v.reframe || ''),
        reframe1: String(base.reframe1 || ''),
        reframe2: String(base.reframe2 || ''),
        createdAt: String(base.createdAt || v.createdAt || ''),
        voters: []
      };
    }
    map[v.targetRid].votes++;
    if (includeVoters) map[v.targetRid].voters.push(String(v.voterName || 'ともだち'));
  }
  var out = [];
  for (var rid in map) {
    if (Object.prototype.hasOwnProperty.call(map, rid) && map[rid].votes > 0) out.push(map[rid]);
  }
  out.sort(function (a, b) {
    if (b.votes !== a.votes) return b.votes - a.votes;
    return dateMillis_(b.createdAt) - dateMillis_(a.createdAt);
  });
  return out.map(function (x) {
      return includeVoters ? x : {
      rid: x.rid,
      votes: x.votes,
      name: x.name,
      troubleLabel: x.troubleLabel,
      reframe: x.reframe,
      reframe1: x.reframe1,
      reframe2: x.reframe2
    };
  });
}

function dateMillis_(s) {
  var t = s ? new Date(s).getTime() : 0;
  return isNaN(t) ? 0 : t;
}
