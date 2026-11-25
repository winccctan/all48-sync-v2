#!/usr/bin/env node
/**
 * 粉丝年报「深度抓取」—— 三源合并后把结果推回 Worker（R2 `fanlive:data:<uid>`）
 *
 * 为什么必须在本机 / GitHub Actions 跑：
 *   口袋 API（pocketapi.48.cn）对 Cloudflare 出口一律 403，Worker 拿不到直播清单和回放地址。
 *   直播礼物只能靠逐场下载回放弹幕（.lrc）解析，这一步必须走能直连的机器。
 *
 * 数据源（三源合并，跨源去重）：
 *   ① msg48 按「粉丝 uid」拉 GIFT_TEXT —— 他自己发出的礼物原文
 *   ② msg48 按「收礼成员 uid」拉 GIFTREPLY —— 成员感谢消息（含送礼人昵称），补 1–6 月
 *   ③ 直播回放弹幕 .lrc —— 直播间送礼广播（房间 IM 里没有）
 *
 * 用法：
 *   node tools/fan-annual-ext.mjs <粉丝uid> [year]            # 抓 + 打印，不上传
 *   node tools/fan-annual-ext.mjs <粉丝uid> [year] --post     # 抓 + POST 回 Worker
 *   NAMES="昵称1,昵称2" node ... <uid> --post                 # 手动指定昵称（跳过自动探测）
 *
 * 环境：
 *   POCKET48_TOKEN  口袋 token（必填，本机可读 ../wangyuchen-archive/scraper/.env）
 *   INGEST_TOKEN    回传令牌（--post 必填）
 *   ANNUAL_INGEST_URL  默认 https://all48.wyc0518.cn/api/fanannual/ext/ingest
 *   直连：env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy SCRAPE_PROXY= node ...
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const UID = String(process.argv[2] || '').trim();
const YEAR = Number(process.argv.slice(3).find((a) => /^\d{4}$/.test(a)) || 2026);
const POST = process.argv.includes('--post');
if (!/^\d{1,20}$/.test(UID)) {
  console.error('用法：node tools/fan-annual-ext.mjs <uid> [year] [--post]');
  process.exit(1);
}

/* ------------------------------------------------------------ token */
function loadToken() {
  if (process.env.POCKET48_TOKEN) return process.env.POCKET48_TOKEN.trim();
  const p = resolve(ROOT, '../wangyuchen-archive/scraper/.env');
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/^POCKET48_TOKEN=(.*)$/m);
    if (m) return m[1].trim();
  }
  return '';
}
const TOKEN = loadToken();
if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }

/* --------------------------------------------------- msg48 客户端 */
const M48 = 'https://msg48.org/api/search';
const M48H = {
  'Content-Type': 'application/json',
  Origin: 'https://msg48.org',
  Referer: 'https://msg48.org/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
};
async function m48pull(userId, sd, ed, msgTypes) {
  const out = new Map();
  for (let off = 0; off < 10000; ) {
    const body = {
      query: '', search_type: 'ik_max_phrase', room_id: '', idol_type: '', team_filter: '',
      msg_types: msgTypes, nickname: '', nickname_search_type: 'ik_max',
      group_by: 'none', sort_order: 'desc',
      user_id: String(userId), start_date: sd, end_date: ed, limit: 1000, offset: off,
    };
    let j = null;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(M48, { method: 'POST', headers: M48H, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if (r.ok) { j = await r.json(); break; }
      } catch (e) { /* retry */ }
    }
    if (!j) break;
    const rs = j.results || [];
    for (const r of rs) out.set(r.id, r);
    off += rs.length;
    if (rs.length < 1000 || off >= Math.min(Number(j.total_count || 0), 10000)) break;
  }
  return [...out.values()];
}

/* ------------------------------------------------ 口袋48 API（需 pa） */
const POCKET = 'https://pocketapi.48.cn';
let _pa = null;
async function genPa() {
  if (_pa) return _pa;
  const mod = await import(resolve(ROOT, 'lib/pa.mjs'));
  _pa = mod.generatePa;
  return _pa;
}
const S = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
const pick = (n) => Array.from({ length: n }, () => S[Math.floor(Math.random() * S.length)]).join('');
const appInfo = JSON.stringify({
  vendor: 'apple',
  deviceId: `${pick(8)}-${pick(4)}-${pick(4)}-${pick(4)}-${pick(12)}`,
  appVersion: '7.0.4', appBuild: '23011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
async function pocket(path, body) {
  const pa = await genPa();
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(POCKET + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8', appInfo,
          'User-Agent': 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)',
          'Accept-Language': 'zh-Hans-AW;q=1', token: TOKEN, pa: pa(),
        },
        body: JSON.stringify(body),
      });
      const t = await r.text();
      if (t.trim().startsWith('{')) return JSON.parse(t);
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 * (a + 1)));
  }
  return null;
}

/* -------------------------------------------------- 成员名 ↔ uid */
let NAME2UID = new Map(), UID2NAME = new Map();
async function loadRoster() {
  try {
    const r = await fetch('https://all48.wyc0518.cc/data/members.js');
    const txt = await r.text();
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    for (const m of arr) {
      if (!m || !m.n) continue;
      NAME2UID.set(String(m.n).trim(), Number(m.id));
      UID2NAME.set(String(m.id), String(m.n));
    }
  } catch (e) { console.error('名册加载失败：' + (e.message || e)); }
}
const normName = (x) => String(x || '').replace(/^(SNH48|GNZ48|BEJ48|CKG48|CGT48|SHY48|IDFT|CII48)-/i, '').trim();

/* -------------------------------------------------------- 主流程 */
const SEGS = [[`${YEAR}-01-01`, `${YEAR}-03-31`], [`${YEAR}-04-01`, `${YEAR}-06-30`], [`${YEAR}-07-01`, `${YEAR}-09-30`], [`${YEAR}-10-01`, `${YEAR}-12-31`]];

async function main() {
  const t0 = Date.now();
  await loadRoster();
  console.error(`名册 ${NAME2UID.size} 人`);

  // ---- 1) 该粉丝的全部记录（用来拿昵称集合 + 房间列表）
  const allRec = {};
  for (const [sd, ed] of SEGS) {
    const rs = await m48pull(UID, sd, ed, []);
    for (const r of rs) allRec[r.id] = r;
  }
  const recs = Object.values(allRec);
  const nameSet = new Set();
  const nameCount = new Map();
  for (const r of recs) {
    const nk = r.nickname ? String(r.nickname).trim() : '';
    if (!nk) continue;
    nameSet.add(nk.toLowerCase());
    nameCount.set(nk, (nameCount.get(nk) || 0) + 1);
  }
  // 手动指定优先
  const manual = String(process.env.NAMES || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (manual.length) { nameSet.clear(); for (const n of manual) nameSet.add(n.toLowerCase()); }
  const names = manual.length ? manual : [...nameCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  console.error(`记录 ${recs.length} 条 · 昵称 ${names.length} 个：${names.slice(0, 6).join(' / ')}${names.length > 6 ? ' …' : ''}`);

  // ---- 2) 成员候选：他说过话的房间 + 送过礼的收礼人
  const members = new Set();
  for (const r of recs) {
    const owner = normName((r.room_info || {}).ownerName);
    if (owner && owner !== '未知房间') members.add(owner);
  }

  const hits = [];
  const push = (t, to, num, g, src) => {
    if (!t || !g) return;
    hits.push({ t, to: normName(to), num: Math.max(1, Number(num) || 1), g: String(g).trim(), src });
  };

  // ---- 3) 源①：按粉丝 uid 的 GIFT_TEXT（礼物原文）
  let textN = 0;
  for (const r of recs) {
    const mt = String(r.msg_type || r.msgType || '');
    if (mt !== 'GIFT_TEXT') continue;
    let b = null; try { b = JSON.parse(r.content); } catch (e) { continue; }
    const gi = b && b.giftInfo; if (!gi) continue;
    push(Number(r.timestamp) || 0, gi.userName, gi.giftNum, gi.giftName, 'text');
    if (gi.userName) members.add(normName(gi.userName));
    textN++;
  }
  console.error(`源① GIFT_TEXT ${textN} 条`);

  // ---- 4) 源②：按成员 uid 的 GIFTREPLY（感谢消息，补 1–6 月）
  let replyN = 0;
  const memberList = [...members].filter((m) => NAME2UID.has(m));
  for (const mn of memberList) {
    const muid = NAME2UID.get(mn);
    for (const [sd, ed] of SEGS) {
      const rs = await m48pull(muid, sd, ed, ['GIFTREPLY', 'AUDIO_GIFT_REPLY']);
      for (const r of rs) {
        let b = null; try { b = JSON.parse(r.content); } catch (e) { continue; }
        const gi = b && (b.giftReplyInfo || b.replyInfo); if (!gi) continue;
        const sn = String(gi.replyName || '').trim();
        if (!nameSet.has(sn.toLowerCase())) continue;
        const m = /(\d+)\s*个\s*(.+)$/.exec(String(gi.replyText || ''));
        if (!m) continue;
        push(Number(r.timestamp) || 0, mn, m[1], m[2], 'reply');
        replyN++;
      }
    }
  }
  console.error(`源② GIFTREPLY 命中 ${replyN} 条`);

  // ---- 5) 源③：直播回放弹幕（直播礼物）
  let lrcN = 0, scanned = 0;
  const sessions = [];
  const seenLive = new Set();
  for (const mn of memberList) {
    const muid = NAME2UID.get(mn);
    let next = '0';
    for (let p = 0; p < 60; p++) {
      const j = await pocket('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true, userId: Number(muid) });
      if (!j || !j.content) break;
      const list = j.content.liveList || [];
      if (!list.length) break;
      let minT = Infinity;
      for (const x of list) {
        const ct = Number(x.ctime) || 0; if (!ct) continue;
        const since = new Date(`${YEAR}-01-01T00:00:00+08:00`).getTime();
        minT = Math.min(minT, ct);
        if (ct < since) continue;
        const id = String(x.liveId);
        if (seenLive.has(id)) continue;
        seenLive.add(id);
        sessions.push({ liveId: id, nick: mn, ctime: ct });
      }
      const nx = String(j.content.next || '0');
      if (!nx || nx === '0' || nx === String(next)) break;
      next = nx;
      if (minT < new Date(`${YEAR}-01-01T00:00:00+08:00`).getTime()) break;
    }
  }
  console.error(`直播场次 ${sessions.length} 场（${memberList.length} 位成员）`);

  const RE_LINE = /^\[(\d+):(\d+):([\d.]+)\]([^\t]*)\t(.*)$/;
  const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++; if (i >= sessions.length) return;
      const ss = sessions[i];
      const one = await pocket('/live/api/v1/live/getLiveOne', { liveId: ss.liveId });
      if (!one || !one.content) continue;
      const url = one.content.msgFilePath;
      if (!url) continue;
      let text = '';
      try { text = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text(); } catch (e) { continue; }
      scanned++;
      for (const line of text.split('\n')) {
        const m = RE_LINE.exec(line.trim()); if (!m) continue;
        const nick = m[4].trim();
        if (!nameSet.has(nick.toLowerCase())) continue;
        const g = RE_GIFT.exec(m[5]); if (!g) continue;
        const off = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
        push(ss.ctime + off, ss.nick, g[2], g[3], 'lrc');
        lrcN++;
      }
      if (scanned % 100 === 0) console.error(`  扫 ${scanned}/${sessions.length} 场，弹幕命中 ${lrcN}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  console.error(`源③ 弹幕 ${scanned} 场，命中 ${lrcN} 条`);

  // ---- 6) 跨源去重：同源内部保留全部（真实连送），只去掉不同源的同一笔
  const order = { text: 0, reply: 1, lrc: 2 };
  hits.sort((a, b) => (a.to === b.to ? (a.t - b.t) || (order[a.src] - order[b.src]) : a.to < b.to ? -1 : 1));
  const kept = [];
  for (const it of hits) {
    const dup = kept.slice(-80).some((k) => k.src !== it.src && k.to === it.to && k.g === it.g && k.num === it.num && Math.abs(k.t - it.t) <= 120000);
    if (!dup) kept.push(it);
  }
  console.error(`合并 ${hits.length} → 去重后 ${kept.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const payload = { uid: UID, year: YEAR, names, hits: kept.map((h) => ({ t: h.t, to: h.to, num: h.num, g: h.g })) };

  if (POST) {
    const url = process.env.ANNUAL_INGEST_URL || 'https://all48.wyc0518.cc/api/fanannual/ext/ingest';
    const tok = process.env.INGEST_TOKEN || '';
    if (!tok) { console.error('缺 INGEST_TOKEN'); process.exit(1); }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': tok },
      body: JSON.stringify(payload),
    });
    const t = await r.text().catch(() => '');
    console.error(`POST ${url} → ${r.status} ${t.slice(0, 200)}`);
    if (!r.ok) process.exit(1);
  } else {
    console.log(JSON.stringify(payload));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
