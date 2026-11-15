/* getLiveOne 全字段 dump：找「在线的人」（2026-11-15） */
import fs from 'node:fs';
const HERE = new URL('.', import.meta.url).pathname;
const envFile = fs.readFileSync(HERE + 'nim-sync.env', 'utf8');
const TOKEN = (envFile.match(/^POCKET48_TOKEN=(.*)$/m) || [])[1].trim();
const APPINFO = JSON.stringify({vendor:'apple',deviceId:'12DAF282-90D5-4E5C-B000-5DD64FC79931',appVersion:'7.1.48',appBuild:'26102601',osVersion:'18.6.0',osType:'ios',deviceName:'iPad (7th generation)',os:'ios'});
const UA='PocketFans201807/7.1.48 (iPad; iOS 18.6; Scale/2.00)';
const post=async(p,b)=>{const r=await fetch('https://pocketapi.48.cn'+p,{method:'POST',headers:{'content-type':'application/json;charset=utf-8',appInfo:APPINFO,token:TOKEN,pa:'POCKET48','user-agent':UA},body:JSON.stringify(b||{})});return await r.json();};
const l=await post('/live/api/v1/live/getLiveList',{debug:true,next:'0',record:false});
const list=((l.content||{}).liveList||[]).filter(x=>x&&x.liveId);
console.log('在播', list.length, '场');
if(!list.length) process.exit(0);
for(const x of list.slice(0,2)){
  const one=(await post('/live/api/v1/live/getLiveOne',{liveId:String(x.liveId)})).content||{};
  const nm=(one.userInfo||{}).nickname||'';
  console.log('\n=== ' + nm + ' liveId=' + x.liveId);
  const hits=[];
  const walk=(o,pre='')=>{
    if(o&&typeof o==='object'){
      for(const [k,v] of Object.entries(o)){
        if(v&&typeof v==='object') walk(v,pre+k+'.');
        else if(/online|view|audience|watch|hot|popul|member|user|fans|count|num/i.test(k)) hits.push([pre+k,v]);
      }
    }
  };
  walk(one);
  for(const [k,v] of hits) console.log('  ', k, '=', String(v).slice(0,50));
  console.log('  全部顶层键:', Object.keys(one).join(','));
}
