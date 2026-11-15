/** 一次性探针：看语音翻牌（AUDIO_GIFT_REPLY）的 bodys 里到底有没有语音转写 */
import fs from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';

const T = process.env.POCKET48_TOKEN;
const txt = fs.readFileSync('../all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const who = process.argv[2] || '陈淑钰';
const bare = (s) => String(s || '').replace(/^SNH48-/, '').replace(/\s+/g, '');
const m = arr.find((x) => bare(x.n) === bare(who));
if (!m) { console.log('找不到成员', who); process.exit(1); }
console.log('member', m.n, 'srv', m.srv, 'ch', m.ch);

let nt = Date.now();
const all = [];
for (let p = 0; p < 5; p++) {
  let r;
  try { r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: nt, limit: 50, token: T }); }
  catch (e) { console.log('拉取失败', String(e.message).slice(0, 80)); break; }
  if (!r.messages.length) break;
  all.push(...r.messages);
  if (!r.nextTime || String(r.nextTime) === String(nt)) break;
  nt = r.nextTime;
}
console.log('拉到', all.length, '条');
const types = {};
for (const x of all) types[x.msgType] = (types[x.msgType] || 0) + 1;
console.log('类型分布', JSON.stringify(types));

const want = all.filter((x) => /REPLY|FLIPCARD|AUDIO|VOICE/i.test(String(x.msgType)));
console.log('候选', want.length);
for (const x of want.slice(0, 10)) {
  console.log('\n---', x.msgType, new Date(Number(x.msgTime)).toISOString());
  const b = typeof x.bodys === 'string' ? x.bodys : JSON.stringify(x.bodys);
  console.log(String(b).slice(0, 1200));
}
