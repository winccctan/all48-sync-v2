/**
 * 房间聊天室在线人数探针（imRoomId 口径 · 2026-11-15）
 * =========================================================
 * 站长：「room 可以啊，你做个 IM 然后查一下它聊天室的人数呗」
 *
 * 和 live-now-push 的区别：
 *   live-now-push 只能查**正在直播**的场（roomId 来自 getLiveOne）；
 *   这里走 `/im/api/v1/im/team/room/info` 的 `imRoomId`，**不开播也能查**，
 *   等于「此刻有几个活人在她房里」。
 *
 * 为什么不用口袋自己的 onlineNum：那是热度，会随时间单调累加（见 live-now-push 头注）。
 * 真正的在线只有云信聊天室 `onlineMemberNum`。
 *
 * 用法：
 *   node probe-room-im.mjs 王语晨
 *   node probe-room-im.mjs 王语晨 蒋夏羽 曹可甜      # 多个
 *   node probe-room-im.mjs --uid 89653517
 *   ACC=2 node probe-room-im.mjs 王语晨              # 换第二个小号（默认 1，被 416 就试 2）
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);
const { createNimCommonlinkChatroomClient } = require('./nim-client/chatroom.cjs');

const HERE = new URL('.', import.meta.url).pathname;
const envFile = fs.readFileSync(HERE + 'nim-sync.env', 'utf8');
const pickEnv = (k) => {
  const m = envFile.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};
const TOKEN = process.env.POCKET48_TOKEN || pickEnv('POCKET48_TOKEN');
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const ACC = Number(process.env.ACC) || 1;
const PER_ROOM_MS = Number(process.env.PER_ROOM_MS) || 18000;

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN（nim-sync.env）'); process.exit(1); }

/* ---------- 名册：名字 / uid → {id, srv, ch} ---------- */
const ROSTER = HERE + '../all48-worker/public/data/members.js';
let MEMBERS = [];
try {
  const t = fs.readFileSync(ROSTER, 'utf8');
  MEMBERS = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
} catch (e) {
  console.error('读不到名册：' + ROSTER + '（' + String((e && e.message) || e) + '）');
  process.exit(1);
}

function findMember(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return MEMBERS.find((m) => Number(m.id) === Number(s)) || null;
  const exact = MEMBERS.filter((m) => String(m.n) === s);
  if (exact.length === 1) return exact[0];
  const fuzzy = MEMBERS.filter((m) => String(m.n).includes(s) || String(m.py || '').includes(s.toLowerCase()));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    console.log('「' + s + '」匹配到多位：' + fuzzy.slice(0, 8).map((m) => m.n).join('、'));
  }
  return null;
}

/* ---------- 口袋 → 房间 imRoomId ---------- */
async function imRoomIdOf(m) {
  const r = await postJson('/im/api/v1/im/team/room/info',
    { serverId: Number(m.srv), channelId: Number(m.ch) }, { token: TOKEN, retries: 1 });
  const c = (r && r.content) || {};
  return {
    roomId: String(c.imRoomId || ''),
    roomName: String((c.channelInfo && c.channelInfo.channelName) || ''),
    functionType: String((c.channelInfo && c.channelInfo.functionType) || ''),
  };
}

/* ---------- 云信凭证 ---------- */
async function nimCred() {
  if (ACC === 2) {
    const a = String(process.env.NIM2_ACCID || '').trim();
    const p = String(process.env.NIM2_PW || '').trim();
    if (a && p) return { accid: a, pwd: p, from: 'env' };
    /* 账号 1 进直播间聊天室恒 416 ⇒ 账号 2 的凭证在 worker（ingest 口令保护），和 live-now-push 同一份 */
    try {
      const site = (process.env.SITE_URL || pickEnv('SITE_URL')).replace(/\/+$/, '');
      const ing = process.env.INGEST_TOKEN || pickEnv('INGEST_TOKEN');
      if (site && ing) {
        const r = await fetch(site + '/api/live/nimcred', {
          headers: { 'x-ingest-token': ing, 'user-agent': 'probe-room-im/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        const j = await r.json();
        if (j && j.ok && j.accid && j.pwd) return { accid: String(j.accid), pwd: String(j.pwd), from: 'site' };
      }
    } catch { /* 落到账号 1 */ }
  }
  const j = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN, retries: 2 });
  const c = (j && j.content) || {};
  return { accid: String(c.accid || ''), pwd: String(c.pwd || ''), from: 'pocket' };
}

/* ---------- 单房间：进房读在线 ---------- */
async function onlineOf(cred, roomId) {
  const cli = createNimCommonlinkChatroomClient({
    appKey: APPKEY, account: cred.accid, token: cred.pwd, roomId,
  });
  try {
    await cli.connect();
    const info = await cli.getChatroomInfo();
    const n = typeof info === 'number' ? info : Number(info && info.onlineMemberNum);
    return Number.isFinite(n) ? n : null;
  } finally {
    try { cli.destroy(); } catch { /* noop */ }
  }
}

/* ---------- 主流程 ---------- */
const argv = process.argv.slice(2);
const queries = argv[0] === '--uid' ? argv.slice(1) : argv;
if (!queries.length) {
  console.log('用法：node probe-room-im.mjs 王语晨 [更多名字...]');
  process.exit(0);
}

const cred = await nimCred();
if (!cred.accid) { console.error('拿不到云信凭证'); process.exit(1); }
console.log('云信账号 ' + cred.accid + '（' + cred.from + '）');

for (const q of queries) {
  const m = findMember(q);
  if (!m) { console.log('✗ 「' + q + '」名册里没有'); continue; }
  let rm;
  try {
    rm = await imRoomIdOf(m);
  } catch (e) {
    console.log('✗ ' + m.n + ' 取 imRoomId 失败：' + String((e && e.message) || e).slice(0, 60));
    continue;
  }
  if (!rm.roomId) { console.log('✗ ' + m.n + ' 没有 imRoomId'); continue; }
  const t0 = Date.now();
  let n = null, err = '';
  try {
    n = await Promise.race([
      onlineOf(cred, rm.roomId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + PER_ROOM_MS + 'ms')), PER_ROOM_MS)),
    ]);
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 60);
  }
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    (n === null ? '✗ ' : '✓ ') + m.n + '（' + m.tm + '）'
    + ' 房间「' + rm.roomName + '」imRoomId=' + rm.roomId
    + ' 在线 ' + (n === null ? '—' : n + ' 人')
    + (err ? ' [' + err + ']' : '')
    + ' (' + cost + 's)'
  );
}
