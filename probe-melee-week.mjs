/**
 * 鸡腿榜「隐藏接口」——最终结论（2026-11-15，7.1.48 实测）
 * =============================================================
 * 站长：「感觉这个鸡腿榜肯定是个隐藏接口，用成员 ID 去查周榜呢」→ 对了，而且找到了。
 *
 * ① 周榜（全站偶像鸡腿，按周）
 *    POST /gift/api/v1/melee/rank/getMeleeWeekRank
 *    body { rankId: 429 }
 *    → { rankUserList: [ {rankNum, melee, baseUserInfo{userId,nickname,...}, topUserInfo{送礼最多的人}} ] }
 *    🔴 参数名是 **rankId**（不是 weekRankId / weekId / id / rankWeekId，那些全返回空数组）
 *    🔴 只回前 7 名，nextId 传回去还是同一页 ⇒ 翻不了页
 *    🔴 只结算「已结束的周」：430（本周）为空，429 是最后一期
 *
 * ② 周 id 列表（哪几周能查）
 *    POST /gift/api/v1/melee/rank/getMeleeRankPage  body { resId: 成员uid }
 *    → { yearRank:{yearRankId,yearRankName}, meleeRank:{nextId,rankUserList[7]},
 *        weekRankList:[{weekRankId:429,weekRankName:"11月02日-11月08日"}, ... 10 期] }
 *    🔴 weekRankList 里字段叫 weekRankId，但**拿去查周榜时参数名要改成 rankId**
 *
 * ③ 年度榜：getMeleeYearRank 试了 {rankId:0}/{yearId:0}/{yearRankId:1} 全空，暂放弃
 * ④ 个人粉丝榜（现在 gf? 用的）：getPersonMeleeRankPage {resId} → TOP16，无分页
 *
 * 用法：
 *   node probe-melee-week.mjs            # 列最近 10 期周榜的 Top3（对照用）
 *   node probe-melee-week.mjs 428        # 只看某一期
 */
import fs from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const envFile = fs.readFileSync(HERE + 'nim-sync.env', 'utf8');
const pickEnv = (k) => {
  const m = envFile.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};
const TOKEN = process.env.POCKET48_TOKEN || pickEnv('POCKET48_TOKEN');
const UID = Number(process.env.UID) || 89653517;
const ONLY = Number(process.argv[2]) || 0;

const APPINFO = JSON.stringify({
  vendor: 'apple', deviceId: '12DAF282-90D5-4E5C-B000-5DD64FC79931',
  appVersion: '7.1.48', appBuild: '26102601', osVersion: '18.6.0',
  osType: 'ios', deviceName: 'iPad (7th generation)', os: 'ios',
});
const UA = 'PocketFans201807/7.1.48 (iPad; iOS 18.6; Scale/2.00)';

const post = async (path, body) => {
  const r = await fetch('https://pocketapi.48.cn' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=utf-8',
      appInfo: APPINFO, token: TOKEN, pa: 'POCKET48',
      'user-agent': UA, accept: '*/*',
    },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 120) }; }
};

const num = (v) => String(Number(v) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* 周 id 列表 */
const meta = await post('/gift/api/v1/melee/rank/getMeleeRankPage', { resId: UID });
const weeks = ((meta.content || {}).weekRankList || []);
if (!weeks.length) { console.error('拿不到 weekRankList：' + JSON.stringify(meta).slice(0, 120)); process.exit(1); }
console.log('最近 ' + weeks.length + ' 期周榜：' + weeks[0].weekRankName + '（最新）→ ' + weeks[weeks.length - 1].weekRankName);

const list = ONLY ? weeks.filter((w) => Number(w.weekRankId) === ONLY) : weeks;
for (const w of list) {
  const j = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', { rankId: Number(w.weekRankId) });
  const c = j.content || {};
  const arr = c.rankUserList || [];
  console.log('\n【周榜 ' + w.weekRankId + '】' + w.weekRankName + '  ' + arr.length + ' 人');
  for (const x of arr) {
    const b = x.baseUserInfo || {};
    const top = x.topUserInfo || {};
    console.log('  ' + String(x.rankNum).padStart(2) + '. ' + String(b.nickname || '')
      + ' ' + num(x.melee) + (top.nickname ? '　(TOP1 送礼 ' + top.nickname + ')' : ''));
  }
}
