import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateArticle } from '../worker/lib/contracts.js';
import { buildImagePlan, attachStoredImages } from '../worker/lib/image-plan.js';
import { postprocessThumbnail } from '../worker/lib/thumbnail-postprocess.js';

const API_HUB = 'https://api-hub-v2.smileseon.workers.dev';
const ORCHESTRATOR = 'https://content-orchestrator.smileseon.workers.dev';
const TARGET_URL = 'https://www.smileinfo.net/2026/08/blog-post_29.html';
const EXPECTED_BLOG_NAME = 'Smile HomeFix';
const EXPECTED_BLOG_HOST = 'www.smileinfo.net';
const BUCKET = 'content-orchestrator-images';
const HUB_API_KEY = String(process.env.API_HUB_V2_KEY || process.env.EXISTING_ORCHESTRATOR_KEY || '').trim();
const REQUIRED = ['DEPLOY_API_TOKEN','R2_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','GEMINI_API_KEY','KIE_API_KEY','TAVILY_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'];

function fail(code){ throw new Error(code); }
function run(command,args,options={}){
  const result=spawnSync(command,args,{stdio:'inherit',...options});
  if(result.status!==0) fail(`COMMAND_FAILED_${command}_${result.status}`);
}
async function callHub(path,body){
  const r=await fetch(`${API_HUB}${path}`,{method:'POST',headers:{'content-type':'application/json','x-hub-api-key':HUB_API_KEY},body:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) fail(`${path}_${r.status}_${data.error||'REQUEST_FAILED'}`);
  return data;
}
async function health(url,label){
  const r=await fetch(`${url}/health?check=${encodeURIComponent(label)}_${Date.now()}`,{cache:'no-store'});
  return {ok:r.ok,data:await r.json().catch(()=>({}))};
}
async function waitHub(predicate,label){
  for(let i=0;i<25;i+=1){const h=await health(API_HUB,`${label}_${i}`);if(h.ok&&predicate(h.data))return h.data;await new Promise(r=>setTimeout(r,1500));}
  fail(`${label}_TIMEOUT`);
}
function deploy(config,secretFile){
  run('npx',['--yes','wrangler@latest','deploy','--config',config,'--secrets-file',secretFile],{cwd:'api-hub-v2',env:{...process.env,CLOUDFLARE_API_TOKEN:process.env.DEPLOY_API_TOKEN}});
}
function r2Put(key,file,mime){
  run('npx',['--yes','wrangler@latest','r2','object','put',`${BUCKET}/${key}`,'--file',file,'--content-type',mime,'--remote'],{env:{...process.env,CLOUDFLARE_API_TOKEN:process.env.R2_API_TOKEN}});
}
function r2Delete(key){
  spawnSync('npx',['--yes','wrangler@latest','r2','object','delete',`${BUCKET}/${key}`,'--remote'],{stdio:'inherit',env:{...process.env,CLOUDFLARE_API_TOKEN:process.env.R2_API_TOKEN}});
}
function stripManagedFigures(html){
  return String(html||'').replace(/<figure\b[^>]*class=["'][^"']*\bpost-image\b[^"']*["'][^>]*>[\s\S]*?<\/figure>\s*/gi,'');
}
function visible(html){return String(html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()}
function isEnglish(article){const t=`${article?.title||''}\n${visible(article?.html||'')}`;const h=(t.match(/[가-힣]/g)||[]).length;const l=(t.match(/[A-Za-z]/g)||[]).length;return h===0&&l>=50}

if(!HUB_API_KEY) fail('HUB_KEY_MISSING');
for(const name of REQUIRED) if(!String(process.env[name]||'').trim()) fail(`${name}_MISSING`);

const secretPath='api-hub-v2/.homefix-aircon-media-secrets.json';
const renderedPath='api-hub-v2/wrangler.jsonc';
const normalPath='api-hub-v2/wrangler.normal.jsonc';
const repairPath='api-hub-v2/wrangler.repair.jsonc';
let normalReady=false;
let updateSucceeded=false;
const uploaded=[];
try{
  run('node',['api-hub-v2/scripts/render-wrangler.mjs'],{env:{...process.env,GOOGLE_OAUTH_SETUP_ENABLED:'false'}});
  const normal=JSON.parse(fs.readFileSync(renderedPath,'utf8'));
  if(normal.vars?.BLOGGER_WRITES_ENABLED!=='false'||normal.vars?.BLOGGER_WRITE_MODE!=='disabled') fail('NORMAL_GATE_NOT_DISABLED');
  fs.writeFileSync(normalPath,JSON.stringify(normal,null,2));
  fs.writeFileSync(secretPath,JSON.stringify({ORCHESTRATOR_API_KEY:HUB_API_KEY,GEMINI_API_KEY:process.env.GEMINI_API_KEY,KIE_API_KEY:process.env.KIE_API_KEY,TAVILY_API_KEY:process.env.TAVILY_API_KEY,GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET,GOOGLE_REFRESH_TOKEN:process.env.GOOGLE_REFRESH_TOKEN}));
  fs.chmodSync(secretPath,0o600); normalReady=true;
  deploy('wrangler.normal.jsonc','.homefix-aircon-media-secrets.json');
  await waitHub(h=>h.bloggerWritesEnabled===false&&h.bloggerWriteMode==='disabled'&&h.tavilyConfigured===true,'SAFE_DISABLED_GATE');
  const orch=await health(ORCHESTRATOR,'aircon_pre');
  if(!orch.ok||orch.data.bloggerWritesEnabled!==false||orch.data.phase2Automation?.autoPublishExecutionEnabled!==false) fail('ORCHESTRATOR_NOT_SAFE');

  const blogs=await callHub('/api/blogger/blogs',{action:'list'});
  const blog=(blogs.blogs||[]).find(b=>{let host='';try{host=new URL(String(b.url||'')).hostname.toLowerCase()}catch{};return String(b.name||b.blogName||'')===EXPECTED_BLOG_NAME&&host===EXPECTED_BLOG_HOST});
  const blogId=String(blog?.id||blog?.blogId||'').trim(); if(!blogId) fail('HOMEFIX_NOT_CONNECTED');
  const current=await callHub('/api/blogger/post/get',{blogId,targetUrl:TARGET_URL,language:'en'});
  const postId=String(current.identity?.bloggerPostId||'').trim(); if(!postId) fail('TARGET_POST_ID_MISSING');
  if(String(current.identity?.status||'').toUpperCase()!=='LIVE') fail('TARGET_NOT_LIVE');
  if(new URL(String(current.identity?.permalink||'')).pathname!==new URL(TARGET_URL).pathname) fail('TARGET_URL_MISMATCH');
  if(!isEnglish(current.article)) fail('AIRCON_POST_NOT_ENGLISH');

  const managedUrls=[...String(current.article?.html||'').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]).filter(src=>src.startsWith(`${ORCHESTRATOR}/media/`));
  let broken=0;
  for(const url of managedUrls){const r=await fetch(url,{cache:'no-store'}).catch(()=>null);if(!r||!r.ok)broken+=1;}
  if(broken===0){console.log('AIRCON_MEDIA_ALREADY_HEALTHY no update needed.');process.exitCode=0;}
  else{
    console.log(`AIRCON_BROKEN_MEDIA_CONFIRMED count=${broken}; replacing managed image set only.`);
    const baseArticle=validateArticle({...current.article,html:stripManagedFigures(current.article.html)});
    const plan=buildImagePlan(baseArticle,{bodyCount:2});
    const rows=[];
    for(let i=0;i<plan.images.length;i+=1){
      const image=plan.images[i];
      const prompt=`${image.prompt}\n\nSTRICT VISUAL RULE: photorealistic editorial home-maintenance image showing a wall-mounted residential air conditioner, condensate drain line, water drip inspection, neutral wall surfaces, hands or simple tools where useful. No packaging, labels, signs, screens, display text, letters, numbers, logos, watermarks, symbols, or text-like glyphs anywhere in the generated source image.`;
      const r=await fetch(`${API_HUB}/api/hub/image/generate`,{method:'POST',headers:{'content-type':'application/json','x-hub-api-key':HUB_API_KEY},body:JSON.stringify({role:image.role,providerMode:'kie',prompt,aspectRatio:image.role==='thumbnail'?'16:9':'4:3'})});
      const g=await r.json().catch(()=>({})); if(!r.ok||g.ok!==true) fail(`KIE_IMAGE_${i}_FAILED`);
      let bytes=Buffer.from(String(g.imageBase64||''),'base64'); let mime=String(g.mimeType||'').split(';')[0].trim().toLowerCase(); let hookText=null;
      if(image.role==='thumbnail'){const p=await postprocessThumbnail(image,g);bytes=Buffer.from(p.bytes);mime=p.mimeType;hookText=p.hookText;}
      const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':mime==='image/jpeg'?'jpg':''; if(!ext||bytes.length<1000) fail('IMAGE_OUTPUT_INVALID');
      const local=`/tmp/homefix-aircon-${i}.${ext}`;const key=`jobs/homefix-aircon-media-repair-${process.env.GITHUB_RUN_ID||Date.now()}/${image.role}-${image.position}.${ext}`;fs.writeFileSync(local,bytes);r2Put(key,local,mime);
      const publicUrl=`${ORCHESTRATOR}/media/${key}`;const read=await fetch(publicUrl,{cache:'no-store'});if(!read.ok) fail('R2_MEDIA_READBACK_FAILED');if(!Buffer.from(await read.arrayBuffer()).equals(bytes)) fail('R2_MEDIA_BYTES_MISMATCH');
      uploaded.push(key);rows.push({id:970000+i,role:image.role,position:image.position,status:'stored',public_url:publicUrl,alt_text:image.altText,storage_key:key,mimeType:mime,hookText});
    }
    const repaired=validateArticle(attachStoredImages(baseArticle,rows));
    if(visible(repaired.html).replace(/\s+/g,' ')!==visible(baseArticle.html).replace(/\s+/g,' ')) fail('TEXT_CHANGED_DURING_MEDIA_REPAIR');

    const gate=structuredClone(normal);gate.vars.BLOGGER_WRITES_ENABLED='true';gate.vars.BLOGGER_WRITE_MODE='phase2_single_repair';gate.vars.PHASE2_SINGLE_REPAIR_BLOG_ID=blogId;gate.vars.PHASE2_SINGLE_REPAIR_POST_ID=postId;fs.writeFileSync(repairPath,JSON.stringify(gate,null,2));
    deploy('wrangler.repair.jsonc','.homefix-aircon-media-secrets.json');
    await waitHub(h=>h.bloggerWritesEnabled===true&&h.bloggerWriteMode==='phase2_single_repair'&&h.tavilyConfigured===true,'EXACT_REPAIR_GATE');
    const updated=await callHub('/api/blogger/post',{phase2SingleRepair:true,operation:'update',blogId,bloggerPostId:postId,article:repaired});if(String(updated.bloggerPostId||'')!==postId) fail('POST_ID_CHANGED');updateSucceeded=true;
    const after=await callHub('/api/blogger/post/get',{blogId,bloggerPostId:postId,language:'en'});if(String(after.identity?.bloggerPostId||'')!==postId||String(after.identity?.status||'').toUpperCase()!=='LIVE') fail('AIRCON_READBACK_FAILED');if(new URL(String(after.identity?.permalink||'')).pathname!==new URL(TARGET_URL).pathname) fail('AIRCON_URL_CHANGED');
    for(const row of rows){if(!String(after.article?.html||'').includes(row.public_url)) fail('NEW_MEDIA_NOT_ATTACHED');const r=await fetch(row.public_url,{cache:'no-store'});if(!r.ok) fail('NEW_MEDIA_BROKEN');}
    const stale=[...String(after.article?.html||'').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1]).filter(src=>managedUrls.includes(src));if(stale.length) fail('STALE_BROKEN_MEDIA_REMAINED');
    console.log(`AIRCON_MEDIA_REPAIR_OK images=${rows.length}; title=${after.article.title}`);console.log(`HOMEFIX_PUBLIC_URL=${after.identity.permalink}`);
  }
}finally{
  if(normalReady&&fs.existsSync(normalPath)&&fs.existsSync(secretPath)){
    try{deploy('wrangler.normal.jsonc','.homefix-aircon-media-secrets.json');await waitHub(h=>h.bloggerWritesEnabled===false&&h.bloggerWriteMode==='disabled'&&h.tavilyConfigured===true,'RESTORE_DISABLED_GATE');const orch=await health(ORCHESTRATOR,'aircon_final');if(!orch.ok||orch.data.bloggerWritesEnabled!==false||orch.data.phase2Automation?.autoPublishExecutionEnabled!==false)fail('FINAL_ORCHESTRATOR_NOT_SAFE');console.log('FINAL_SAFETY_OK APIHubWrites=OFF; OrchestratorWrites=OFF; AutoPublish=OFF; Tavily=true');}catch(e){console.error(`RESTORE_FAILURE=${String(e.message||'unknown')}`);process.exitCode=1;}
  }
  if(!updateSucceeded){for(const key of uploaded)r2Delete(key)}else if(uploaded.length)console.log('UPDATED_POST_OWNS_NEW_MEDIA; no R2 cleanup performed.');
  for(const p of [secretPath,renderedPath,normalPath,repairPath]){try{fs.unlinkSync(p)}catch{}}
  for(let i=0;i<5;i+=1){for(const ext of ['png','webp','jpg']){try{fs.unlinkSync(`/tmp/homefix-aircon-${i}.${ext}`)}catch{}}}
}
