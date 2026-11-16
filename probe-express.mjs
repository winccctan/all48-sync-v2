/** 一次性探针：口袋房间里的「表情包 / EXPRESSIMAGE」消息 bodys 到底长什么样。
 * 起因：2026-11-16 14:14 王语晨发了个表情包，群里只收到 `[EXPRESSIMAGE]`，没图、没内容。
 * 只看结构，不上报、不写库。
 *   node probe-express.mjs [srv] [ch]      默认王语晨的房间
 */
import { MEMBER, POCKET48_TOKEN } from './lib/config.mjs';
import { fetchMessagePage } from './lib/api.mjs';

const srv = Number(process.argv[2] || MEMBER.serverId);
const ch = Number(process.argv[3] || MEMBER.channelId);
console.log('房间', srv, ch, 'token=', POCKET48_TOKEN ? 'ok' : '缺');

let nextTime = 0;
const seen = [];
for (let p = 0; p < 8; p++) {
  const r = await fetchMessagePage({ serverId: srv, channelId: ch, nextTime, limit: 50, token: POCKET48_TOKEN });
  const msgs = r.messages || [];
  if (!msgs.length) break;
  for (const m of msgs) seen.push({ t: Number(m.msgTime) || 0, type: m.msgType, bodys: m.bodys, ext: m.extInfo });
  nextTime = r.nextTime;
  if (!nextTime) break;
}
const types = {};
for (const s of seen) types[s.type] = (types[s.type] || 0) + 1;
console.log('共', seen.length, '条; 类型分布', types);

const ex = seen.filter((s) => /EXPRESS|EMOJI|EMOTION|STICKER/i.test(String(s.type)));
console.log('\n表情类条数', ex.length);
for (const s of ex.slice(0, 6)) {
  const dt = new Date(s.t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  console.log('\n---', dt, s.type, '---');
  console.log(String(s.bodys).slice(0, 1500));
}
