/**
 * 聚聚页「排序会动」探针（只读 / 全脱敏）
 * ------------------------------------------------------------
 * 背景：站长在 App 聚聚页观察到头像排序会随成员上下线变动。
 * mitm 抓到的都是后台轮询（team/last/message/get、specialeffects、
 * ongoing/live/info），没抓到列表接口。这里直接用业务 token 把这些
 * 接口打一遍，看响应里到底有没有 online / status / presence / lastTime
 * 这类可以推「上线」的字段。
 *
 * 🔴 只读：不调用任何写接口。
 * 🔴 脱敏：uid / 昵称 / URL 一律不落地、不打印明文。
 *
 * 用法：node probe-jujiu-online.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://pocketapi.48.cn';
const { generatePa } = await import('./lib/pa.mjs');
const PA = generatePa();

const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN
  || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN')
  || pick(env(ROOT + 'fb.env'), 'POCKET48_TOKEN');
if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }

/* 与 iPad 7.1.48 抓包环境对齐 */
const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.1.48', appBuild: '24011601',
  osVersion: '18.6', osType: 'ios', deviceName: 'iPad (7th gen)', os: 'ios',
});
const UA = 'PocketFans201807/7.1.48 (iPad; iOS 18.6; Scale/2.00)';

async function call(method, path, body) {
  const args = [
    '-sS', '--noproxy', '*', '-m', '20', '-X', method, API + path,
    '-H', 'Content-Type: application/json;charset=utf-8',
    '-H', 'appInfo: ' + appInfo,
    '-H', 'token: ' + TOKEN,
    '-H', 'pa: ' + PA,
    '-H', 'User-Agent: ' + UA,
    '-H', 'Accept-Language: zh-Hans-CN;q=1',
  ];
  if (method !== 'GET' && body !== undefined) args.push('-d', JSON.stringify(body));
  try {
    const { stdout } = await run('curl', args, { maxBuffer: 24e6 });
    try { return JSON.parse(stdout); } catch { return { _raw: stdout.slice(0, 300) }; }
  } catch (e) { return { _curlError: String(e.message).slice(0, 160) }; }
}

/* 递归脱敏：13 位毫秒时间戳保留（要判排序依据），其余长数字/中文/URL 全部打码 */
function scrub(v, depth = 0) {
  if (v == null) return v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 3).map((x) => scrub(x, depth + 1));
    if (v.length > 3) head.push(`…+${v.length - 3}`);
    return head;
  }
  if (typeof v === 'object') {
    if (depth > 6) return '<deep>';
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrub(x, depth + 1);
    return o;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  if (/^1[5-9]\d{11}$/.test(s)) return s;                 // 毫秒时间戳，保留
  if (/^\d{5,}$/.test(s)) return `<id:${s.length}>`;      // uid / resId
  if (/^https?:\/\//.test(s)) return `<url:${s.length}>`;
  if (/[\u4e00-\u9fa5]/.test(s)) return `<zh:${s.length}>`;
  if (s.length > 28) return `<str:${s.length}>`;
  return s;
}

/* 收集所有叶子字段名，重点标出「在线/状态/排序/时间」类 */
const HINT = /online|presence|status|state|sort|order|last|time|active|live|login|weight|rank|top/i;
function leafFields(v, out = new Map(), path = '') {
  if (Array.isArray(v)) { v.slice(0, 2).forEach((x) => leafFields(x, out, path + '[]')); return out; }
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) {
    const p = path ? path + '.' + k : k;
    const t = Array.isArray(x) ? `array(${x.length})` : typeof x;
    out.set(p, (out.get(p) || 0) + 1);
    if (x && typeof x === 'object') leafFields(x, out, p);
    if (HINT.test(k)) out.set(p + '  <<<HINT ' + t, 1);
  }
  return out;
}

const CALLS = [
  ['POST', '/im/api/v1/team/last/message/get', {}],
  ['POST', '/im/api/v1/team/last/message/get', { lastTime: 0 }],
  ['POST', '/live/api/v1/live/getAll/ongoing/live/info', {}],
  ['GET', '/live/api/v1/live/get/all/specialeffects?clientTime=1790154183523', undefined],
  ['POST', '/user/api/v1/friendships/friends', {}],
  ['POST', '/user/api/v1/im/userinfo', {}],
];

/* --params：只读探测 team/last/message/get 的参数名。
   用假房间号，只看错误信息从「房间id不能为空」变成什么，不碰真实房间数据。 */
if (process.argv.includes('--params')) {
  const bodies = [
    { roomId: 1 }, { roomId: '1' }, { roomIds: [1] }, { roomIds: ['1'] },
    { roomIds: '1' }, { teamId: 1 }, { teamIds: [1] }, { ids: [1] },
    { roomIdList: [1] }, { imRoomId: 1 }, { targetIds: [1] },
    { roomId: 1, lastTime: 0 }, { roomIds: [1], debug: true },
  ];
  for (const b of bodies) {
    const d = await call('POST', '/im/api/v1/team/last/message/get', b);
    const c = d && d.content !== undefined ? d.content : d;
    console.log(JSON.stringify(b).padEnd(34), '=>', d.status,
      String(d.message || d.msg || '').padEnd(14),
      'contentKeys=' + (c && typeof c === 'object' ? Object.keys(c).join(',') : String(c).slice(0, 40)));
  }
  process.exit(0);
}

/* --server <id> [--watch <轮数> <间隔秒>]：复刻聚聚页「最后消息」接口并做多轮 diff。
   🔴 参数名来自站长 mitm 原文：{"serverId":"29298945"}（不是 roomId/teamId）。
   🔴 全脱敏：channelId / msgContent / starName 一律只留短 hash 与长度，绝不落地明文。 */
if (process.argv.includes('--server')) {
  const sid = String(process.argv[process.argv.indexOf('--server') + 1] || '29298945');
  const wi = process.argv.indexOf('--watch');
  const rounds = wi >= 0 ? Math.max(1, Number(process.argv[wi + 1] || 5)) : 1;
  const gap = wi >= 0 ? Math.max(0, Number(process.argv[wi + 2] || 20)) : 0;
  const h8 = (s) => createHash('md5').update(String(s)).digest('hex').slice(0, 8);
  const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
  let prev = null;

  for (let r = 1; r <= rounds; r++) {
    const d = await call('POST', '/im/api/v1/team/last/message/get', { serverId: sid });
    const list = (d && d.content && Array.isArray(d.content.lastMsgList)) ? d.content.lastMsgList : [];
    const cur = list.map((x) => ({
      ch: h8(x && x.channelId),                       // 频道短签（可跨轮比对位置）
      msg: h8(x && x.msgContent),                     // 内容短签（变了＝有新消息）
      name: h8(x && x.starName),                      // 成员名短签（不打印明文）
      keys: x && typeof x === 'object' ? Object.keys(x).join(',') : '',
      n: String((x && x.msgContent) || '').length,
    }));
    const order = cur.map((x) => x.ch).join('>');
    const orderSig = h8(order);
    console.log(`[${stamp()}] 轮 ${r}/${rounds}  status=${d.status} 条数=${list.length} 顺序签=${orderSig} 顺序=${order}`);
    if (r === 1) {
      console.log('  单条字段: ' + (cur[0] ? cur[0].keys : '（无）') + '  内容长度=' + (cur[0] ? cur[0].n : '-'));
      console.log('  content 顶层键: ' + Object.keys((d && d.content) || {}).join(','));
    }
    if (prev) {
      const pm = new Map(prev.map((x, i) => [x.ch, { i, msg: x.msg }]));
      const cm = new Map(cur.map((x, i) => [x.ch, { i, msg: x.msg }]));
      const added = cur.filter((x) => !pm.has(x.ch)).map((x) => x.ch);
      const gone = prev.filter((x) => !cm.has(x.ch)).map((x) => x.ch);
      const moved = cur.filter((x) => pm.has(x.ch) && pm.get(x.ch).i !== cm.get(x.ch).i)
        .map((x) => `${x.ch}:${pm.get(x.ch).i}→${cm.get(x.ch).i}`);
      const edited = cur.filter((x) => pm.has(x.ch) && pm.get(x.ch).msg !== x.msg).map((x) => x.ch);
      console.log(`  对比上轮: 顺序${orderSig === h8(prev.map((x) => x.ch).join('>')) ? '不变' : '⭐变了'}` +
        ` 新增=${added.length ? added.join(',') : '-'} 消失=${gone.length ? gone.join(',') : '-'}` +
        ` 位移=${moved.length ? moved.join(',') : '-'} ⭐内容变=${edited.length ? edited.join(',') : '-'}`);
    }
    prev = cur;
    if (r < rounds) await new Promise((rs) => setTimeout(rs, gap * 1000));
  }
  process.exit(0);
}

for (const [method, path, body] of CALLS) {
  const d = await call(method, path, body);
  console.log('\n' + '='.repeat(78));
  console.log(method + ' ' + path + (body ? '  body=' + JSON.stringify(body) : ''));
  console.log('顶层: status=' + d.status + ' message=' + (d.message || d.msg || '-') +
    ' errorCode=' + (d.errorCode || '-') + (d._raw ? ' RAW=' + d._raw : '') +
    (d._curlError ? ' ERR=' + d._curlError : ''));
  const content = d.content !== undefined ? d.content : d;
  const F = leafFields(content);
  const hints = [...F.keys()].filter((k) => k.includes('<<<HINT'));
  console.log('字段总数=' + F.size + '  ⭐在线/状态/排序类字段(' + hints.length + '):');
  console.log(hints.length ? hints.map((h) => '   ' + h).join('\n') : '   （无）');
  console.log('结构样本(脱敏, 数组只取前3):');
  console.log(JSON.stringify(scrub(content), null, 2).slice(0, 3500));
}
