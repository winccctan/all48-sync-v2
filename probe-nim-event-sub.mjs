/**
 * 官方 node-nim SDK · 在线状态事件服务「只读」连通性验证
 * ------------------------------------------------------------
 * 为什么要有这个脚本（2026-11-15）：
 *   APK dex 里确认 App 用了 netease EventSubscribeService.subscribeEvent
 *   （eventType=1 在线状态 / syncCurrentValue 同步当前值）→ 聚聚页排序是本地算的。
 *   之前所有「抓不到上下线」的结论来自两处，都不是官方 SDK 路径：
 *     · lib/yunxin-presence.mjs 走服务端 REST（需 AppSecret，粉丝号没有）
 *     · nim-client/presence-probe.mjs 走自拼 commonlink 裸包（14/3 一直被拒）
 *   本脚本改用官方 node-nim SDK 完整登录握手，验证 14/* 事件服务是否在这条
 *   正式连接上可用。
 *
 * 🔴 只读：只做 login + querySubscribe（14/6）。**不调用 subscribe / publish**，
 *    不改任何订阅关系、不发消息、不写库、不写站点。
 * 🔴 账号：只用第二账号 nim-client/nim-account2.env，避免踢掉线上主采集连接。
 * 🔴 脱敏：accid / 昵称 / uid 一律不打印明文，仅打印长度与 resultCode 等数字。
 *
 * 用法：node probe-nim-event-sub.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = import.meta.dirname;
const NODE_NIM = '/Users/tansy/.workbuddy/binaries/node-nim/node-nim';
const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const APP_DATA = resolve(ROOT, 'nim-state/nim-event-probe');
const SEC = Number(process.env.PROBE_SEC || 10);

const envText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pick = (t, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(t || '');
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const E2 = envText(resolve(ROOT, 'nim-client/nim-account2.env'));
const ACCID = pick(E2, 'NIM2_ACCID');
const PW = pick(E2, 'NIM2_PW');

const ts = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
/* 只保留数字/短枚举，长字符串与中文一律打码 */
const safe = (v, d = 0) => {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => safe(x, d + 1)).concat(v.length > 3 ? [`…+${v.length - 3}`] : []);
  if (typeof v === 'object') {
    if (d > 4) return '<deep>';
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = safe(x, d + 1);
    return o;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  if (s.length <= 5 && !/[\u4e00-\u9fa5]/.test(s)) return s;
  return `<str:${s.length}>`;
};

if (!ACCID || !PW) { console.error('缺第二账号凭据 nim-client/nim-account2.env'); process.exit(1); }
log(`第二账号 accid 长度=${ACCID.length} token 长度=${PW.length}（不打印明文）`);

let sdk;
try { sdk = require(NODE_NIM); }
catch (e) { console.error('node-nim 加载失败：' + e.message); process.exit(1); }

mkdirSync(APP_DATA, { recursive: true });
const ok = sdk.nim.client.init(APPKEY, APP_DATA, '', {});
log('client.init =', ok);
if (!ok) process.exit(2);
sdk.nim.initEventHandlers();

const loginRes = await sdk.nim.client.login(APPKEY, ACCID, PW, null, '');
const r = Array.isArray(loginRes) ? loginRes[0] : loginRes;
log('login res_code_ =', r && r.res_code_, 'login_step_ =', r && r.login_step_,
  '（成功码', sdk.NIMResCode.kNIMResSuccess, '）');
if (!r || r.res_code_ !== sdk.NIMResCode.kNIMResSuccess) {
  log('🔴 登录失败 → 官方 SDK 这条路在此账号上走不通');
  try { sdk.nim.client.cleanup(); } catch {}
  process.exit(3);
}
log('✅ 官方 SDK IM 登录成功');

/* 事件模块：拦截 emit，抓所有在线状态推送（无需猜事件名） */
const sub = new sdk.NIMSubscribeEvent();
sub.initEventHandlers();
const origEmit = sub.emit.bind(sub);
let eventCount = 0;
sub.emit = (name, ...args) => {
  eventCount++;
  log(`⭐ 事件 [${name}] ` + JSON.stringify(safe(args)).slice(0, 400));
  return origEmit(name, ...args);
};
log('事件模块已就绪，事件名：' + JSON.stringify(sub.eventNames()));

/* 只读查询：14/6 querySubscribeByAccounts。不订阅、不改关系 */
const ET = sdk.NIMEventType.kNIMEventTypeOnlineState;   // 1
try {
  const q = await sub.querySubscribe(ET, [ACCID], null, '');
  log('querySubscribe 返回：' + JSON.stringify(safe(q)).slice(0, 600));
} catch (e) {
  log('querySubscribe 异常：' + String(e.message).slice(0, 200));
}

log(`保持连接 ${SEC} 秒，观察是否有 14/2 / 14/9 在线事件推送…`);
await new Promise((r2) => setTimeout(r2, SEC * 1000));
log(`观察结束：收到事件 ${eventCount} 条`);
try { sdk.nim.client.logout(); } catch {}
try { sdk.nim.client.cleanup(); } catch {}
process.exit(0);
