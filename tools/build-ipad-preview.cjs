// Build the offline student preview from the same card and hint logic as Apps Script.
// Run: node tools/build-ipad-preview.cjs <output.html>
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function installDemo(supportText) {
  function runner(ok, fail) {
    return new Proxy({}, {
      get(_, method) {
        if (method === 'withSuccessHandler') return fn => runner(fn, fail);
        if (method === 'withFailureHandler') return fn => runner(ok, fn);
        return arg => setTimeout(() => {
          try {
            let result;
            if (method === 'moreHint') {
              result = moreHint(arg);
            } else if (method === 'askMoyatto') {
              const last = arg.messages.filter(m => m.role === 'user').slice(-1)[0];
              result = last && isHeavyTopic_(last.text)
                ? { support: true, reply: supportText }
                : { cleared: false, progress: 0, reply: '書いた見方を読んだよ。「ヒントを もう一つ」を おしてみてね。' };
            } else if (method === 'proposeTrouble') {
              result = { ok: false, message: '画面見本では登録しません。' };
            }
            if (ok) ok(result);
          } catch (error) { if (fail) fail(error); }
        }, 80);
      }
    });
  }
  window.google = { script: { run: runner() } };
}

function buildPreview(outputPath) {
  const source = path.resolve(__dirname, '..', 'src');
  const read = name => fs.readFileSync(path.join(source, name), 'utf8');
  const ctx = vm.createContext({});
  for (const name of ['Config.gs', 'Code.gs', 'Avatars.gs', 'UiImages.gs']) {
    vm.runInContext(read(name), ctx, { filename: name });
  }
  const cards = ctx.enrichTroubles_(ctx.DEFAULT_TROUBLES).map(({ reframes, ...card }) => card);
  const data = { modesJson: ctx.MODES, troublesJson: cards, avatarsJson: ctx.getAvatars_(),
    uiImagesJson: ctx.getUiImages_(), sessionJson: { code: '', mode: '', flags: {} } };
  const serialize = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const message = serialize(ctx.adultSupport_().reply);
  const helpers = ['isHeavyTopic_', 'hintContext_', 'hintWords_', 'similarHint_', 'chooseHint_', 'moreHint']
    .map(name => ctx[name].toString()).join('\n');
  const script = [
    '(function(){', 'const MAX_MESSAGES=' + ctx.MAX_MESSAGES + ', MAX_TEXT_LEN=' + ctx.MAX_TEXT_LEN + ';',
    'function findTrouble_(id){return TROUBLES.find(t => t.id === id);}',
    'function hasApiKey_(){return false;} function isTrialActive_(){return false;}',
    'function adultSupport_(){return {reply:' + message + '};}', helpers,
    '(' + installDemo.toString() + ')(' + message + ');', '})();'
  ].join('\n');
  const banner = '<aside style="padding:7px 14px;text-align:center;background:#e4f2f4;color:#184f5b;font:600 14px/1.5 system-ui,sans-serif">画面見本　入力に合わせたヒントを試せます。AI判定とクラスへの保存はお休みです。</aside>';
  const html = read('index.html').replace(/<\?!=\s*(\w+)\s*\?>/g, (_, key) => {
    if (!(key in data)) throw Error('Missing template value ' + key);
    return serialize(data[key]);
  }).replace(/<link[^>]*https:\/\/fonts\.[^>]+>\s*/g, '')
    .replace('<body>', () => '<body>' + banner + '<script>' + script + '</script>')
    .replace('</body>', () => '<script>openMode(MODES.find(m=>m.id==="dekigoto"));startTrouble(TROUBLES.find(t=>t.id==="test"));</script></body>');
  fs.writeFileSync(outputPath, html);
}

if (require.main === module) {
  if (!process.argv[2]) throw Error('Specify the output HTML path.');
  buildPreview(process.argv[2]);
}
module.exports = { buildPreview };
