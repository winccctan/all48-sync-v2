#!/usr/bin/env node
/**
 * 成员年报「外部数据」生成器 —— 直播场次 + 逐场送礼榜 + 直播礼物明细 + 公演场次
 *
 * 为什么不在 Worker 里抓：口袋 API（pocketapi.48.cn）对 Cloudflare 出口返回 403，
 * 和 push-watch 必须跑 Actions 是同一个坑。所以这几块必须在这里（本机 / Actions）抓，
 * 生成 JSON 推到 R2 的 `annual:ext:<uid>:<year>`，Worker 的 /api/annual/gen 只做聚合。
 *
 * 用法：
 *   node tools/annual-ext.mjs 89653427 2026            # 抓 + 打印，不落 R2
 *   node tools/annual-ext.mjs 89653427 2026 --put      # 抓 + 推 R2（本机）
 *   node tools/annual-ext.mjs 89653427 2026 --post     # 抓 + POST 回 Worker（CI 用，不碰 R2 凭据）
 *
 * token：优先 env POCKET48_TOKEN，否则读 ../wangyuchen-archive/scraper/.env
 * 直连：env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy SCRAPE_PROXY= node ...
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UID = String(process.argv[2] || '').trim();
const YEAR = Number(process.argv[3] || new Date().getUTCFullYear());
const PUT = process.argv.includes('--put');
const POST = process.argv.includes('--post');
if (!/^\d{6,15}$/.test(UID)) {
  console.error('用法：node tools/annual-ext.mjs <uid> <year> [--put|--post]');
  process.exit(1);
}

const R2_BUCKET = 'all48-arc';

function loadToken() {
  if (process.env.POCKET48_TOKEN) return process.env.POCKET48_TOKEN.trim();
  const cands = [
    new URL('../../../2026-09-17-16-15-19/wangyuchen-archive/scraper/.env', import.meta.url).pathname,
    new URL('../../wangyuchen-archive/scraper/.env', import.meta.url).pathname,
    '/Users/tansy/WorkBuddy/2026-09-17-16-15-19/wangyuchen-archive/scraper/.env',
  ];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const m = /^POCKET48_TOKEN\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(p, 'utf8'));
    if (m) return m[1].trim();
  }
  return '';
}
const TOKEN = loadToken();
if (!TOKEN) { console.error('没找到 POCKET48_TOKEN'); process.exit(1); }

const APPINFO = JSON.stringify({
  vendor: 'apple', deviceId: '12DAF282-90D5-4E5C-B000-5DD64FC79931',
  appVersion: '7.1.48', appBuild: '26102601', osVersion: '18.6.0',
  osType: 'ios', deviceName: 'iPad (7th generation)', os: 'ios',
});
const UA = 'PocketFans201807/7.1.48 (iPad; iOS 18.6; Scale/2.00)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch('https://pocketapi.48.cn' + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=utf-8',
          appInfo: APPINFO, token: TOKEN, pa: 'POCKET48', 'user-agent': UA,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (j && j.content) return j.content;
      if (j && j.status === 400) return null;
    } catch (e) { /* 抖动，重试 */ }
    await sleep(700 * (a + 1));
  }
  return null;
}

const bj = (t) => new Date(t + 8 * 3600e3);
const ym = (t) => bj(t).toISOString().slice(0, 7);

// ---------- 1. 直播清单 ----------
const yStart = Date.UTC(YEAR, 0, 1) - 8 * 3600e3;
const yEnd = Date.UTC(YEAR + 1, 0, 1) - 8 * 3600e3;
const lives = [];
let next = '0';
for (let p = 0; p < 40; p++) {
  const c = await post('/live/api/v1/live/getLiveList', { userId: Number(UID), limit: 20, nextTime: 0, next });
  const list = (c && c.liveList) || [];
  if (!list.length) break;
  let stop = false;
  for (const l of list) {
    const ct = Number(l.ctime) || 0;
    if (ct < yStart) { stop = true; continue; }
    if (ct >= yEnd) continue;
    lives.push({ id: String(l.liveId), ct });
  }
  if (stop || !c.next) break;
  next = String(c.next);
  await sleep(200);
}
process.stderr.write(`直播清单 ${lives.length} 场\n`);

// ---------- 2. 逐场送礼榜 ----------
const ranks = [];
let cur = 0, done = 0;
const worker = async () => {
  while (cur < lives.length) {
    const lv = lives[cur++];
    const c = await post('/live/api/v2/live/getLiveRank', { type: 1, liveId: lv.id }, 2);
    const data = (c && c.data) || [];
    for (const x of data) {
      const m = Number(x.money) || 0;
      if (!m) continue;
      ranks.push({
        u: String((x.user || {}).userId || '0'),
        nick: String((x.user || {}).userName || '').trim(),
        m, ct: lv.ct, id: lv.id,
      });
    }
    if (++done % 40 === 0) process.stderr.write(`  榜单 ${done}/${lives.length}\n`);
  }
};
await Promise.all(Array.from({ length: 6 }, worker));

const sess = new Set(ranks.map((x) => x.id)).size;

// ---------- 3. 公演（OPEN_LIVE） ----------
const perf = new Map();
let nt = 0;
for (let p = 0; p < 80; p++) {
  const c = await post('/im/api/v1/chatroom/msg/list/aim/type',
    { extMsgType: 'OPEN_LIVE', roomId: '', ownerId: UID, nextTime: Number(nt) || 0 }, 2);
  const list = (c && c.message) || [];
  if (!list.length) break;
  for (const m of list) {
    let ex = {};
    try { ex = JSON.parse(m.extInfo || '{}'); } catch (e) { ex = {}; }
    const id = String(m.msgidClient || ex.id || '');
    if (!id) continue;
    const ow = String((ex.user || {}).userId || '');
    if (ow && ow !== UID) continue;
    const st = Number(ex.startTime || m.msgTime) || 0;
    if (st) perf.set(id, { id, st });
  }
  if (!c.nextTime || String(c.nextTime) === String(nt)) break;
  nt = c.nextTime;
  await sleep(150);
}

// ---------- 3b. 直播礼物明细（回放弹幕 .lrc） ----------
// 🔴 直播送礼不走房间 IM，房间礼物原文里根本没有；但每场直播结束后的回放弹幕
//   （getLiveOne → msgFilePath 的 .lrc）里有一行一条的「昵称 \t 送给GNZ48-某某 1个XX」。
//   年报的「礼物种类」要含直播间，只能从这里补（站长 2026-11-23 要求）。
//   只取件数，不取金额 —— 金额已经由上面的逐场送礼榜给过，再加会双算。
const lgKinds = new Map();     // 礼物名 -> 件数
const lgPeople = new Map();    // 昵称 -> 件数
let lgSess = 0, lgPieces = 0;
{
  let cur2 = 0, lgDone = 0;
  const worker2 = async () => {
    while (cur2 < lives.length) {
      const lv = lives[cur2++];
      const c = await post('/live/api/v1/live/getLiveOne', { liveId: lv.id }, 2);
      const fp = c && c.msgFilePath;
      if (fp) {
        const url = /^https?:/.test(fp) ? fp : 'https://' + String(fp).replace(/^\/+/, '');
        let txt = '';
        try {
          const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
          if (r.ok) txt = await r.text();
        } catch (e) { txt = ''; }
        if (txt) {
          let hit = false;
          for (const line of txt.split('\n')) {
            // 形如：[00:16:27.174]zZ🐾\t送给GNZ48-陈淑钰 1个灵犀花灯
            const m = /^\[(\d+):(\d+):(\d+(?:\.\d+)?)\]([^\t]+)\t送给\S*\s*(\d+)个(.+?)\s*$/.exec(line.trim());
            if (!m) continue;
            const nick = m[4].trim();
            const num = Math.min(999, Math.max(1, Number(m[5]) || 1));
            const name = m[6].trim();
            if (!nick || !name) continue;
            hit = true;
            lgKinds.set(name, (lgKinds.get(name) || 0) + num);
            lgPeople.set(nick, (lgPeople.get(nick) || 0) + num);
            lgPieces += num;
          }
          if (hit) lgSess++;
        }
      }
      if (++lgDone % 20 === 0) process.stderr.write(`  回放 ${lgDone}/${lives.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker2));
}
process.stderr.write(`直播礼物 ${lgPieces} 件 / ${lgKinds.size} 种 / 有送礼 ${lgSess} 场\n`);

const byMonth = (arr, key) => {
  const o = {};
  for (let m = 1; m <= 12; m++) o[`${YEAR}-${String(m).padStart(2, '0')}`] = 0;
  for (const x of arr) {
    const k = ym(x[key]);
    if (o[k] != null) o[k]++;
  }
  return o;
};
const perfYear = [...perf.values()].filter((x) => bj(x.st).getUTCFullYear() === YEAR);
// 榜单明细只留该年的（直播清单已按年过滤，这里再兜一次）
const rankYear = ranks.filter((x) => x.ct >= yStart && x.ct < yEnd);

const out = {
  at: Date.now(), uid: UID, year: YEAR,
  live: {
    total: lives.length, sess,
    byMonth: byMonth(lives.map((l) => ({ ct: l.ct })), 'ct'),
    ranks: rankYear,
  },
  perf: { total: perfYear.length, byMonth: byMonth(perfYear, 'st') },
  // 直播间礼物（回放弹幕解析）：只有件数，金额在 ranks 里
  lg: {
    pieces: lgPieces, sess: lgSess,
    kinds: Object.fromEntries([...lgKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)),
    people: Object.fromEntries([...lgPeople.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300)),
  },
};

const real = rankYear.filter((x) => x.u !== '0').reduce((a, x) => a + x.m, 0);
process.stderr.write(`直播 ${lives.length} 场 / 有榜 ${sess} 场 / 实名鸡腿 ${real}\n`);
process.stderr.write(`公演 ${perfYear.length} 场 | 明细 ${rankYear.length} 行\n`);

const tmp = `/tmp/annual-ext-${UID}-${YEAR}.json`;
writeFileSync(tmp, JSON.stringify(out));
process.stderr.write(`已写 ${tmp}（${(JSON.stringify(out).length / 1024).toFixed(0)} KB）\n`);

if (POST) {
  // CI 通道：不配 R2 凭据，直接把结果 POST 回 Worker（x-ingest-token 用仓库 secret INGEST_TOKEN）
  const url = process.env.ANNUAL_INGEST_URL || 'https://all48.wyc0518.cc/api/annual/ext/ingest';
  const tok = process.env.INGEST_TOKEN || '';
  if (!tok) { console.error('缺 INGEST_TOKEN'); process.exit(1); }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-token': tok },
    body: JSON.stringify({ uid: UID, year: YEAR, ext: out }),
  });
  const t = await r.text().catch(() => '');
  console.error('POST ' + url + ' → ' + r.status + ' ' + t.slice(0, 200));
  if (!r.ok) process.exit(1);
}

if (PUT) {
  const key = `${R2_BUCKET}/annual:ext:${UID}:${YEAR}`;
  execFileSync('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', key, `--file=${tmp}`, '--remote'], {
    stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname,
  });
  process.stderr.write(`已推 R2：annual:ext:${UID}:${YEAR}\n`);
}
