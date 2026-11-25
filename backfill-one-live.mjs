/*
 * 单成员直播礼物回补（快验用）：按 userId 拉该成员全部录播，逐场扫 LRC 礼物，写 lv:all。
 * 用法：MID=175374368 node backfill-one-live.mjs
 */
import { postJson, fetchNewestLiveId, fetchLiveListPage } from './lib/api.mjs';
import { priceOf } from './lib/gift-price.mjs';

const TOKEN = process.env.POCKET48_TOKEN;
const SITE = process.env.SITE_URL;
const INGEST = process.env.INGEST_TOKEN;
const MID = Number(process.env.MID || 0);
const SINCE = Date.parse((process.env.SINCE || '2026-05-03') + 'T00:00:00+08:00');
const CONC = Math.max(1, Number(process.env.CONC || 4));

if (!MID || !TOKEN || !SITE || !INGEST) { console.log('missing env'); process.exit(1); }

function durMs(s) {
  const p = String(s || '').split(':').map(Number);
  if (!p.length || p.some((n) => !isFinite(n))) return 0;
  let sec = 0;
  for (const v of p) sec = sec * 60 + v;
  return sec * 1000;
}

// ① 拉该成员全部录播
const start = await fetchNewestLiveId();
console.log('newest liveId =', start);
let next = start;
const lives = new Map();
let pages = 0;
while (pages < 400) {
  let r;
  try { r = await fetchLiveListPage({ userId: MID, next, record: true }); }
  catch (e) { console.log('list page ' + pages + ' fail: ' + String(e.message).slice(0, 60)); break; }
  const list = r.list || [];
  if (!list.length) break;
  let oldest = Infinity;
  for (const x of list) {
    const ct = Number(x.ctime || 0) || 0;
    if (!x.liveId) continue;
    if (ct > 0) oldest = Math.min(oldest, ct);
    if (ct && ct >= SINCE) {
      lives.set(String(x.liveId), { liveId: String(x.liveId), ctime: ct, dur: durMs(x.duration), nick: (x.userInfo && x.userInfo.nickname) || '' });
    }
  }
  pages++;
  if (oldest < SINCE) break;
  if (!r.next || String(r.next) === '0' || String(r.next) === String(next)) break;
  next = String(r.next);
}
console.log('pages=' + pages + ' 场次=' + lives.size + '（SINCE 之后）');
const arr = [...lives.values()].sort((a, b) => a.ctime - b.ctime);

// ② 逐场扫 LRC
const RE_TAB = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const RE_SP = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const items = [];
let hit = 0, noLrc = 0, done = 0;

async function scan(lv) {
  let url = '';
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { token: TOKEN, retries: 1 });
    url = ((d && d.content) || {}).msgFilePath || '';
  } catch (e) { return; }
  if (!url) { noLrc++; return; }
  let txt = '';
  try {
    const res = await fetch(url);
    txt = await res.text();
  } catch (e) { return; }
  for (const line of txt.split('\n')) {
    const m = line.match(RE_TAB) || line.match(RE_SP);
    if (!m) continue;
    const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
    const ms = Number(m[4] || 0);
    const t = lv.ctime + (hh * 3600 + mm * 60 + ss) * 1000 + ms;
    const num = Number(m[7]) || 1;
    const gift = String(m[8] || '').trim();
    const v = priceOf('', gift);
    items.push({ t, mid: MID, sid: 0, sn: '', g: gift, num, v: v || 0, room: 2 });
    hit++;
  }
}

const queue = arr.slice();
async function worker() {
  while (queue.length) {
    const lv = queue.shift();
    await scan(lv);
    done++;
    if (done % 20 === 0) console.log('扫 ' + done + '/' + arr.length + ' 命中 ' + hit);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('扫完 ' + arr.length + ' 场 | 礼物 ' + hit + ' 条 | 无回放 ' + noLrc);

// ③ 上报
let pushed = 0;
for (let i = 0; i < items.length; i += 2000) {
  const part = items.slice(i, i + 2000);
  try {
    const res = await fetch(SITE + '/api/lv/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({ ch: 'live', items: part }),
    });
    const out = await res.json().catch(() => ({}));
    pushed += part.length;
    console.log('上报 ' + part.length + ' → ' + JSON.stringify(out.days || out).slice(0, 120));
  } catch (e) { console.log('上报失败 ' + String(e.message).slice(0, 80)); }
}
const total = items.reduce((a, r) => a + (r.v || 0) * r.num, 0);
console.log('共上报 ' + pushed + ' 条 | 鸡腿 ' + total);
