/** 临时探针：把某成员房间最近的**图片消息**原始 bodys 打出来，
 *  用来核对「群里只出 [图片] 不出真图」时 URL 字段到底叫什么。
 *  用法：node probe-img.mjs 曾雪婷 [回看分钟数] */
import fs from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';

const T = process.env.POCKET48_TOKEN;
const txt = fs.readFileSync('../all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const who = process.argv[2] || '曾雪婷';
const mins = Number(process.argv[3] || 240);
const bare = (s) => String(s || '').replace(/^[A-Z]+48-/, '').replace(/\s+/g, '');
const m = arr.find((x) => bare(x.n) === bare(who));
if (!m) { console.log('找不到成员', who); process.exit(1); }

const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' ');
const floor = Date.now() - mins * 60e3;

let nt = Date.now();
const all = [];
for (let p = 0; p < 10; p++) {
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

console.log(`${who}（uid=${m.uid} srv=${m.srv} ch=${m.ch}）最近 ${mins} 分钟共 ${all.length} 条`);
const kinds = {};
for (const x of all) kinds[x.msgType] = (kinds[x.msgType] || 0) + 1;
console.log('类型分布：', JSON.stringify(kinds));

const hit = all.filter((x) => /IMAGE|PIC|PHOTO/i.test(String(x.msgType || ''))
  || /"ext":"(jpg|jpeg|png|gif|webp)"/i.test(String(x.bodys || '')));
console.log(`\n疑似图片消息 ${hit.length} 条：`);
for (const x of hit.slice(0, 6)) {
  console.log('---', bj(x.msgTime), x.msgType);
  console.log('bodys =', String(x.bodys || '').slice(0, 600));
  console.log('extInfo =', String(x.extInfo || '').slice(0, 200));
}
