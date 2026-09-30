// Exercise the real mini-program API module against the public leaderboard only.
// No WeChat session, login credentials or private endpoints are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const loaded = { exports: {} };
let requests = 0;
const wx = {
  getStorageSync: () => '',
  request(options) {
    if (!/^https:\/\/tokenrank\.xmasdong\.cn\/api\/leaderboard\?scope=global&period=day$/.test(options.url)) {
      throw new Error('Benchmark permits only the public daily leaderboard');
    }
    requests++;
    execFile('curl', ['--silent', '--show-error', '--fail', '--max-time', '20', options.url], (error, body) => {
      if (error) options.fail({ errMsg: error.message });
      else {
        try { options.success({ statusCode: 200, data: JSON.parse(body) }); }
        catch (err) { options.fail({ errMsg: err.message }); }
      }
    });
  },
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils/api.js'), 'utf8'), {
  wx, module: loaded, require: id => require(path.join(root, 'miniprogram/utils', id)),
});
(async () => {
  const samples = [];
  for (const [label, force] of [['first-read', false], ['repeat-read', false], ['forced-refresh', true]]) {
    const start = performance.now(), before = requests;
    await loaded.exports.fetchLeaderboard({ scope: 'global', period: 'day' }, { force });
    samples.push({ label, elapsed_ms: Math.round((performance.now() - start) * 100) / 100, requests: requests - before });
  }
  const report = { measured_at: new Date().toISOString(), scope: 'local Node harness, real API module and public network; not phone timings', samples };
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(root, 'artifacts/releases/2026-09-28-read-cache.json'), JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
