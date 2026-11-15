/** 临时探针：列出某成员房间最近 N 分钟的消息（北京时间），用来核对「群里丢没丢」 */
import fs from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';

const T = process.env.POCKET48_TOKEN;
const txt = fs.readFileSync('../all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const who = process.argv[2] || '王语晨';
const mins = Number(process.argv[3] || 60);
const bare = (s) => String(s || '').replace(/^SNH48-/, '').replace(/\s+/g, '');
const m = arr.find((x) => bare(x.n) === bare(who));
if (!m) { console.log('找不到成员', who); process.exit(1); }

const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 23).replace('T', ' ');
const floor = Date.now() - mins * 60e3;

let nt = Date.now();
const all = [];
for (let p = 0; p < 8; p++) {
  let r;
  try { r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: nt, limit: 50, token: T }); }
  catch (e) { console.log('拉取失败', String(e.message).slice(0, 80)); break; }
  if (!r.messages.length) break;
  all.push(...r.messages);
  const oldest = Math.min(...r.messages.map((x) => Number(x.msgTime) || Infinity));
  if (oldest < floor) break;
  if (!r.nextTime || String(r.nextTime) === String(nt)) break;
  nt = r.nextTime;
}

const mine = all.filter((x) => Number(x.msgTime) >= floor).sort((a, b) => Number(a.msgTime) - Number(b.msgTime));
console.log(`${who} srv=${m.srv} ch=${m.ch} 最近 ${mins} 分钟共 ${mine.length} 条`);
for (const x of mine) {
  let body = '';
  try {
    const b = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : x.bodys;
    body = String(b && (b.text || b.content || '') || '');
    if (!body && b) body = JSON.stringify(b).slice(0, 80);
  } catch { body = String(x.bodys || '').slice(0, 80); }
  console.log(bj(x.msgTime), x.msgType, '|', body.replace(/\s+/g, ' ').slice(0, 70));
}
