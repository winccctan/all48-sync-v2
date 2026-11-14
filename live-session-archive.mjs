/**
 * 直播场次归档（`kpi?` 的数据源）
 * =============================================================
 * 站长 2026-11-15：「做一个直播 KPI 统计，数量定义是必须是一个自然日、直播时长 ≥1 小时算 1 个，
 * 按月算」。要按天算时长，就必须有**每场的开播时间和总时长** —— 礼物首末笔只能当下限
 * （没人送礼的场次等于 0），所以我们改用口袋官方的场次记录：
 *
 *   POST /live/api/v1/live/getLiveList  { record:true, next:'0' }
 *     → content.liveList[20]，每项 { liveId, ctime(开播毫秒), duration('HH:MM:SS'), userInfo.userId }
 *     → content.next 是游标（上一页最后一条的 liveId），一直翻能回到很早以前
 *
 * 实测（2026-11-15）：120 页 = 2400 场，回到 10-24；每页 ~0.5s，翻 3 天约 60~100 页。
 *
 * 落地：POST {SITE_URL}/api/live/sessions
 *   body { days: { '20261115': [[liveId, uid, start, dur], …] } }
 *   worker 侧**并集**合并（同一场取更长的 duration，在播时会一直涨）。
 *
 * 用法：
 *   node live-session-archive.mjs                 # 默认回溯 3 天（增量，每 10 分钟跑）
 *   DAYS=7 node live-session-archive.mjs          # 回溯 7 天
 *   SINCE=20261001 node live-session-archive.mjs  # 一次性补到 10-01（第一次上 KPI 时用）
 *   DRY=1 node live-session-archive.mjs           # 只打印，不写
 *
 * 环境变量：SITE_URL / INGEST_TOKEN / POCKET48_TOKEN / SCRAPE_PROXY
 */
import { postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const DRY = !!process.env.DRY;
const DAYS = Math.max(1, Math.min(62, Number(process.env.DAYS) || 3));
const SINCE = String(process.env.SINCE || '').replace(/[^0-9]/g, '');
const MAX_PAGES = Math.max(10, Math.min(600, Number(process.env.MAX_PAGES) || 260));

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }

const BJ = 8 * 3600e3;
const p2 = (n) => String(n).padStart(2, '0');
const bjDay = (ms) => {
  const d = new Date(Number(ms) + BJ);
  return String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
};
const bjHM = (ms) => {
  const d = new Date(Number(ms) + BJ);
  return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
};

/** 'HH:MM:SS' / 'MM:SS' / 数字（秒） → 毫秒 */
function durMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.max(0, Math.round(v * 1000));
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const p = s.split(':').map(Number);
  if (p.some((x) => isNaN(x))) return 0;
  while (p.length < 3) p.unshift(0);
  return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000;
}

/** 回溯下界（毫秒）：SINCE 优先，否则 now - DAYS 天（含今天算 DAYS 个自然日） */
const cutoff = SINCE
  ? Date.UTC(Number(SINCE.slice(0, 4)), Number(SINCE.slice(4, 6)) - 1, Number(SINCE.slice(6, 8))) - BJ
  : Date.now() - (DAYS - 1) * 86400e3 - (Date.now() + BJ) % 86400e3;   // 从 DAYS 天前的 0 点起

/* ---------------------------------------------------------------- 翻页 */
const byDay = new Map();       // 'YYYYMMDD' → Map(liveId → row)
const seen = new Set();
let pages = 0, total = 0, oldest = Infinity;
let next = '0';
const t0 = Date.now();

while (pages < MAX_PAGES) {
  let j = null;
  try {
    j = await postJson('/live/api/v1/live/getLiveList', { record: true, next: String(next) }, { token: TOKEN, retries: 2 });
  } catch (e) {
    console.warn('翻页失败（第 ' + (pages + 1) + ' 页）：' + String((e && e.message) || e).slice(0, 120));
    break;
  }
  const c = (j && j.content) || {};
  const list = Array.isArray(c.liveList) ? c.liveList : [];
  if (!list.length) break;
  pages++;

  for (const it of list) {
    const id = String(it.liveId || '');
    const uid = String((it.userInfo && it.userInfo.userId) || '');
    const st = Number(it.ctime) || 0;
    const du = durMs(it.duration);
    if (!id || !uid || !st || !du) continue;
    if (st < oldest) oldest = st;
    if (st < cutoff) continue;               // 比窗口更早的不要
    if (seen.has(id)) continue;              // 同一条被翻到两次（游标边界）
    seen.add(id);
    total++;
    const d = bjDay(st);
    if (!byDay.has(d)) byDay.set(d, new Map());
    byDay.get(d).set(id, [id, uid, st, du]);
  }

  /* 列表按开播时间倒序：这一页最旧的一条已经越过下界 ⇒ 再翻只会更旧，收工 */
  const minCtime = Math.min(...list.map((x) => Number(x.ctime) || Infinity));
  if (minCtime < cutoff) break;

  const nx = c.next;
  if (!nx || String(nx) === '0' || String(nx) === String(next)) break;
  next = nx;
  /* 每页之间歇一下：连翻几百页不放开请求间隔容易被风控 */
  await new Promise((r) => setTimeout(r, 120));
}

const dayKeys = [...byDay.keys()].sort();
console.log(`翻 ${pages} 页 · ${total} 场 · ${dayKeys.length} 天 · 最旧 ${oldest < Infinity ? bjHM(oldest) : '-'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const d of dayKeys) console.log(`  ${d}: ${byDay.get(d).size} 场`);

if (DRY) { console.log('(DRY) 不写入'); process.exit(0); }
if (!dayKeys.length) { console.log('窗口内没有场次，不写'); process.exit(0); }

/* ---------------------------------------------------------------- 上报（按 5 天一批） */
let ok = 0, fail = 0;
for (let i = 0; i < dayKeys.length; i += 5) {
  const chunk = dayKeys.slice(i, i + 5);
  const days = {};
  for (const d of chunk) days[d] = [...byDay.get(d).values()];
  try {
    const r = await fetch(SITE + '/api/live/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-token': INGEST,
        'user-agent': 'all48-live-sess/1.0',
      },
      body: JSON.stringify({ days }),
      signal: AbortSignal.timeout(30000),
    });
    const txt = await r.text();
    if (r.ok) { ok += chunk.length; console.log('上报 ' + r.status + ' ' + chunk.join(',') + ' → ' + txt.slice(0, 140)); }
    else { fail += chunk.length; console.warn('上报失败 ' + r.status + ' ' + txt.slice(0, 140)); }
  } catch (e) {
    fail += chunk.length;
    console.warn('上报异常 ' + chunk.join(',') + '：' + String((e && e.message) || e).slice(0, 140));
  }
}
console.log(`完成：${ok} 天成功 / ${fail} 天失败`);
if (fail) process.exit(1);
