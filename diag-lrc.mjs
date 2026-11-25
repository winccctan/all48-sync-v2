import { postJson } from './lib/api.mjs';
const TOKEN = process.env.POCKET48_TOKEN;
// 翻列表找到 2026 年 5~9 月的场次，各取 2 个，测 getLiveOne 的回放 msgFilePath 还在不在
const buckets = {};  // month -> [liveId...]
let next = '0';
let pages = 0;
while (pages < 700) {
  let r;
  try { r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 2 }); }
  catch (e) { console.log('list fail page ' + pages + ': ' + String(e.message).slice(0, 60)); break; }
  const c = (r && r.content) || {};
  const list = Array.isArray(c.liveList) ? c.liveList : [];
  if (!list.length) break;
  let oldest = Infinity;
  for (const x of list) {
    const ct = Number(x.ctime || 0);
    if (!ct) continue;
    oldest = Math.min(oldest, ct);
    const m = new Date(ct + 8 * 3600e3).toISOString().slice(0, 7);
    if (m >= '2026-05' && m <= '2026-09') {
      buckets[m] = buckets[m] || [];
      if (buckets[m].length < 2) buckets[m].push(String(x.liveId));
    }
  }
  pages++;
  if (oldest < Date.parse('2026-05-01T00:00:00+08:00')) break;
  const nn = c.next;
  if (nn == null || String(nn) === '0' || String(nn) === String(next)) { console.log('cursor stop at page ' + pages); break; }
  next = String(nn);
}
console.log('pages=' + pages + ' buckets=' + JSON.stringify(buckets));
for (const m of Object.keys(buckets).sort()) {
  for (const lid of buckets[m]) {
    let url = '';
    try {
      const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lid }, { token: TOKEN, retries: 1 });
      url = ((d && d.content) || {}).msgFilePath || '';
    } catch (e) { console.log(m + ' ' + lid + ' getLiveOne ERR ' + String(e.message).slice(0, 50)); continue; }
    console.log(m + ' liveId=' + lid + ' msgFilePath=' + (url ? 'YES len=' + url.length : 'EMPTY'));
  }
}
