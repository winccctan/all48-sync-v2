import { postJson, fetchNewestLiveId, fetchLiveListPage } from './lib/api.mjs';
const TOKEN = process.env.POCKET48_TOKEN;
const MID = 175374368;
const start = await fetchNewestLiveId();
let next = start;
const lives = [];
let pages = 0;
while (pages < 20) {
  const r = await fetchLiveListPage({ userId: MID, next, record: true });
  const list = r.list || [];
  if (!list.length) break;
  for (const x of list) {
    const ct = Number(x.ctime || 0);
    if (ct && ct >= Date.parse('2026-05-03T00:00:00+08:00')) lives.push({ liveId: String(x.liveId), ctime: ct });
  }
  pages++;
  if (!r.next || String(r.next) === '0' || String(r.next) === String(next)) break;
  next = String(r.next);
}
lives.sort((a, b) => a.ctime - b.ctime);
// 取 5 月的第一场
const target = lives.find((x) => new Date(x.ctime + 8 * 3600e3).toISOString().slice(0, 7) === '2026-05') || lives[0];
console.log('总计 ' + lives.length + ' 场, 抽查 ' + new Date(target.ctime + 8 * 3600e3).toISOString());
const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: target.liveId }, { retries: 1 });
const url = ((d && d.content) || {}).msgFilePath || '';
console.log('LRC url=' + (url ? 'YES' : 'EMPTY'));
if (url) {
  const res = await fetch(url);
  const txt = await res.text();
  const lines = txt.split('\n');
  console.log('总行数 ' + lines.length);
  const re1 = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
  const re2 = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
  let m1 = 0, m2 = 0, hasGift = 0;
  const un = [];
  for (const l of lines) {
    if (re1.test(l)) m1++;
    else if (re2.test(l)) m2++;
    if (l.indexOf('送给') >= 0) { hasGift++; if (!re1.test(l) && !re2.test(l) && un.length < 8) un.push(l.slice(0, 120)); }
  }
  console.log('re1匹配=' + m1 + ' re2匹配=' + m2 + ' 含"送给"行=' + hasGift);
  console.log('--- 未匹配的"送给"行样例 ---');
  for (const u of un) console.log(JSON.stringify(u));
  console.log('--- 前5行 ---');
  for (const l of lines.slice(0, 5)) console.log(JSON.stringify(l.slice(0, 120)));
}
