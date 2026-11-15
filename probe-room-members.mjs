/**
 * 房间在线观众列表（13/8 getChatroomMembers + 13/9 弹幕补昵称 · 2026-11-15）
 * =====================================================================
 * 站长：「getChatroomMembers」—— 要房间里在的人，**只要昵称不要 ID**。
 *
 * 协议（从 NIM_Web_Chatroom_nodejs.js 反出来的，非猜测）：
 *   13/8 getChatroomMembers
 *     params = [ {Byte} type, {Long} time, {Int} limit ]
 *     Byte=1B；Int=int32 小端 4B；Long=int64 小端 8B（定长！不是 varint）
 *     type：0=固定成员(房主) 1=游客(desc) 2=仅在线 3=游客(非desc)
 *     响应：PropertyArray，元素是 Property（varint 键值对数 + (键,len,值)*）
 *   13/9 getHistoryMsgs → 每条消息 field 21 = 发送者 accid，field 4 = JSON（user.nickName）
 *     ⇒ 拿最近的弹幕做 accid → 昵称 的映射，给成员列表补名。
 *
 * 关键坑：NIM 侧的成员档案里 nick 字段（5）口袋根本不写（全为空），
 *        所以「昵称」只能从消息里倒推——没发过言的人补不出名。
 *
 * 用法：
 *   node probe-room-members.mjs 王语晨            # 成员自己的房间（imRoomId，不开播也能查）
 *   node probe-room-members.mjs --live 张倩       # 查她正在播的直播间
 *   node probe-room-members.mjs --room 5738186306 # 直接给云信聊天室 id
 *   默认用账号 2（账号 1 进聊天室恒 416）
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);
const { createNimCommonlinkChatroomClient } = require('./nim-client/chatroom.cjs');

const HERE = new URL('.', import.meta.url).pathname;
const envFile = fs.readFileSync(HERE + 'nim-sync.env', 'utf8');
const pickEnv = (k) => { const m = envFile.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = process.env.POCKET48_TOKEN || pickEnv('POCKET48_TOKEN');
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const ACC = Number(process.env.ACC) || 2;   // 账号 1 进聊天室恒 416，默认用账号 2
const LIMIT = Number(process.env.LIMIT) || 100;

/* ---------- 名册 ---------- */
const ROSTER = HERE + '../all48-worker/public/data/members.js';
let MEMBERS = [];
try {
  const t = fs.readFileSync(ROSTER, 'utf8');
  MEMBERS = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
} catch (e) { console.error('读不到名册'); process.exit(1); }
const findMember = (q) => {
  const s = String(q || '').trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return MEMBERS.find((m) => Number(m.id) === Number(s)) || null;
  const ex = MEMBERS.filter((m) => String(m.n) === s);
  if (ex.length === 1) return ex[0];
  const fz = MEMBERS.filter((m) => String(m.n).includes(s));
  return fz.length === 1 ? fz[0] : null;
};

/* ---------- 云信凭证 ---------- */
async function nimCred() {
  if (ACC === 2) {
    const a = String(process.env.NIM2_ACCID || '').trim();
    const p = String(process.env.NIM2_PW || '').trim();
    if (a && p) return { accid: a, pwd: p, from: 'env' };
    try {
      const site = (process.env.SITE_URL || pickEnv('SITE_URL')).replace(/\/+$/, '');
      const ing = process.env.INGEST_TOKEN || pickEnv('INGEST_TOKEN');
      if (site && ing) {
        const j = await (await fetch(site + '/api/live/nimcred', {
          headers: { 'x-ingest-token': ing, 'user-agent': 'probe-room-members/2.0' },
          signal: AbortSignal.timeout(15000),
        })).json();
        if (j && j.ok && j.accid && j.pwd) return { accid: String(j.accid), pwd: String(j.pwd), from: 'site' };
      }
    } catch { /* 落到账号 1 */ }
  }
  const j = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN, retries: 2 });
  const c = (j && j.content) || {};
  return { accid: String(c.accid || ''), pwd: String(c.pwd || ''), from: 'pocket' };
}

/* ---------- 编解码 ---------- */
const u8 = (n) => Buffer.from([Number(n) & 0xff]);
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(Number(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(Number(n)))); return b; };
const str = (x) => { const b = Buffer.from(String(x), "utf8"); return Buffer.concat([vint(b.length), b]); };
const vint = (n) => { const a = []; let v = Number(n) >>> 0; do { let x = v & 0x7f; v = Math.floor(v / 128); if (v) x |= 0x80; a.push(x); } while (v); return Buffer.from(a); };
const rd = (b, o) => { let v = 0, s = 0, x; do { x = b[o++]; v += (x & 0x7f) * Math.pow(2, s); s += 7; } while (x & 0x80); return { v, o }; };

function parseArr(buf) {
  if (!buf || !buf.length) return [];
  let p = rd(buf, 0); const n = p.v; let o = p.o;
  const out = [];
  for (let i = 0; i < n && o < buf.length; i++) {
    p = rd(buf, o); const pairs = p.v; o = p.o;
    const rec = {};
    for (let k = 0; k < pairs; k++) {
      p = rd(buf, o); const key = p.v; o = p.o;
      p = rd(buf, o); const len = p.v; o = p.o;
      rec[key] = buf.subarray(o, o + len).toString('utf8'); o += len;
    }
    out.push(rec);
  }
  return out;
}

/* ---------- 主流程 ---------- */
const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith('--')) || '';
const val = argv.filter((a) => !a.startsWith('--'))[0] || '';

let roomId = '';
if (mode === '--room') roomId = val;
else if (!val) { console.log('用法：node probe-room-members.mjs <成员名> | --live <成员名> | --room <imRoomId>'); process.exit(0); }

let label = '';
if (!roomId) {
  const m = findMember(val);
  if (!m) { console.log('✗ 「' + val + '」名册里没有'); process.exit(1); }
  label = m.n;
  if (mode === '--live') {
    const l = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 1 });
    const hit = ((l.content || {}).liveList || []).find((x) => x && x.userInfo && String(x.userInfo.nickname || '').includes(m.n));
    if (!hit) { console.log('✗ ' + m.n + ' 现在没在播'); process.exit(1); }
    const one = ((await postJson('/live/api/v1/live/getLiveOne', { liveId: String(hit.liveId) }, { token: TOKEN, retries: 1 })).content) || {};
    roomId = String(one.roomId || '');
    console.log('直播中 ' + m.n + ' liveId=' + hit.liveId + ' roomId=' + roomId + ' 官方热度=' + one.onlineNum);
  } else {
    const r = await postJson('/im/api/v1/im/team/room/info', { serverId: Number(m.srv), channelId: Number(m.ch) }, { token: TOKEN, retries: 1 });
    const c = (r && r.content) || {};
    roomId = String(c.imRoomId || '');
    console.log(m.n + ' 房间「' + ((c.channelInfo || {}).channelName || '') + '」imRoomId=' + (roomId || '—'));
  }
  if (!roomId) process.exit(1);
}

const cred = await nimCred();
if (!cred.accid) { console.error('拿不到云信凭证'); process.exit(1); }

const cli = createNimCommonlinkChatroomClient({ appKey: APPKEY, account: cred.accid, token: cred.pwd, roomId });
try {
  await cli.connect();
} catch (e) {
  console.log('✗ 进房失败：' + String(e.message).slice(0, 80) + '（试试 ACC=2）');
  process.exit(1);
}
const info = await cli.getChatroomInfo();
const online = Number(info.onlineMemberNum) || 0;

/* 1) 成员列表 */
const members = parseArr((await cli.requestRaw(13, 8, Buffer.concat([u8(1), i64(0), i32(LIMIT)]))).body);

/* 2) 昵称主路：13/16 getChatroomMembersInfo（StrArray=accid）→ 键 5 = nick、键 10 = 进房时间
   🔴 2026-11-15 补：这个命令之前漏了。成员资料里就有昵称，**没发过言的人也有名字**，
      不必再从弹幕倒推（弹幕只作兜底，给那些没设聊天室昵称的账号补）。 */
const ACCS = members.map((x) => String(x[2] || '')).filter(Boolean);
const nickOf = new Map();
if (ACCS.length) {
  const r = await cli.requestRaw(13, 16, Buffer.concat([vint(ACCS.length), ...ACCS.map(str)]));
  for (const x of parseArr(r.body)) {
    const a = String(x[2] || ''), nk = String(x[5] || '').trim();
    if (a && nk) nickOf.set(a, nk);
  }
  console.log('13/16 成员资料：' + ACCS.length + ' 个 accid → 有昵称 ' + nickOf.size + ' 个');
}

/* 3) 兜底：没设昵称的用弹幕里的 user.nickName 补（13/9 从最新往前翻，reverse=0 才是越翻越早） */
const PAGES = Number(process.env.MSG_PAGES) || 12;
const lack = ACCS.filter((a) => a !== cred.accid && !nickOf.has(a));
if (lack.length) {
  let tag = 0;
  for (let page = 0; page < PAGES; page++) {
    const list = parseArr((await cli.requestRaw(13, 9, Buffer.concat([i64(tag), i32(100), u8(0), u8(0)]))).body);
    if (!list.length) break;
    let minTs = Infinity;
    for (const m of list) {
      const ts = Number(m[20] || 0);
      if (ts && ts < minTs) minTs = ts;
      const from = String(m[21] || '');
      if (!from || nickOf.has(from)) continue;
      let pl = {}; try { pl = JSON.parse(m[4] || '{}'); } catch { /* 系统消息 */ }
      const u = pl.user || {};
      if (u.nickName) nickOf.set(from, String(u.nickName));
    }
    if (!Number.isFinite(minTs) || minTs === tag) break;
    tag = minTs;
  }
}

const others = members.filter((x) => String(x[2]) !== cred.accid);
console.log('');
console.log('聊天室 ' + roomId + ' 在线人数 ' + online + '（含我方账号）');
console.log('游客列表 ' + members.length + ' 人（去掉自己后 ' + others.length + '），其中能对上昵称的 '
  + others.filter((x) => nickOf.has(String(x[2]))).length + ' 人');
console.log('---');
others.sort((a,b)=>(Number(b[10])||0)-(Number(a[10])||0)).forEach((x, i) => {
  const acc = String(x[2]);
  const nm2 = nickOf.get(acc);
  const t = x[10] ? new Date(Number(x[10])).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  console.log(String(i + 1).padStart(2) + '. ' + (nm2 || '（没设昵称）') + '  进房 ' + t);
});
cli.destroy();
process.exit(0);
