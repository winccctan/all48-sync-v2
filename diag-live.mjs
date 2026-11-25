import { postJson } from './lib/api.mjs';
const TOKEN = process.env.POCKET48_TOKEN;
let next = '0';
for (let page = 0; page < 4; page++) {
  const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 2 });
  const c = (r && r.content) || {};
  const list = Array.isArray(c.liveList) ? c.liveList : [];
  console.log('--- page ' + page + ' count=' + list.length + ' next=' + c.next + ' ---');
  if (list.length) {
    const a = list[0], b = list[list.length - 1];
    console.log('keys: ' + Object.keys(a).join(','));
    console.log('  ctime raw=' + JSON.stringify(a.ctime) + ' type=' + (typeof a.ctime) + ' num=' + Number(a.ctime));
    console.log('  iso=' + (isFinite(Number(a.ctime)) ? new Date(Number(a.ctime)).toISOString() : 'INVALID'));
    console.log('  liveId=' + a.liveId + ' status=' + a.status + ' duration=' + JSON.stringify(a.duration));
    const ct2 = Number(b.ctime);
    console.log('  last ctime iso=' + (isFinite(ct2) ? new Date(ct2).toISOString() : 'INVALID'));
  }
  const nn = c.next;
  if (nn == null || String(nn) === '0' || String(nn) === String(next)) { console.log('cursor stop: ' + nn); break; }
  next = String(nn);
}
