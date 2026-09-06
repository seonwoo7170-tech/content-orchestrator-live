import test from 'node:test';
import assert from 'node:assert/strict';
import { processStoredJob } from '../worker/lib/stored-job-executor.js';

const article = { title:'T', html:'<p>x</p>', searchDescription:'d', language:'ko', topic:'t', labels:[], sources:[] };
function router(items) { return async () => { const item=items.shift(); return new Response(JSON.stringify(item), {status:200}); }; }

test('new article stored job records full pipeline state path and stops at ready', async () => {
  const states=[];
  const fetchImpl=router([
    {article},
    {status:'FAIL',issues:[{code:'X',severity:'MEDIUM',location:'html p 1',reason:'r',repairInstruction:'fix only html p 1'}]},
    {article:{...article,html:'<p>fixed</p>'}},
    {status:'PASS',issues:[]}
  ]);
  const out=await processStoredJob({API_HUB_BASE_URL:'https://hub',HUB_API_KEY:'k'}, {id:1,mode:'new_article',status:'queued',blog_id:'b',topic:'t',payload_json:'{"language":"ko"}'}, {fetchImpl,saveState:async(s)=>states.push(s)});
  assert.deepEqual(states,['writing','critic_review','repairing','final_critic','ready']);
  assert.equal(out.state,'ready');
});

test('stored job supports repeated Natural Writing targeted repairs before Critic', async () => {
  const states=[];
  const blocked={...article,html:'<p>현대 사회에서 PC 성능의 중요성이 더욱 커지고 있습니다.</p>'};
  const stillBlocked={...article,html:'<p>빠르게 변화하는 시대에 PC 성능의 중요성이 커지고 있습니다.</p>'};
  const clean={...article,html:'<p>PC가 느려졌다면 작업 관리자에서 높은 사용률 항목부터 확인하세요.</p>'};
  const fetchImpl=router([
    {article:blocked},
    {article:stillBlocked},
    {article:clean},
    {status:'PASS',score:98,issues:[]}
  ]);
  const out=await processStoredJob({API_HUB_BASE_URL:'https://hub',HUB_API_KEY:'k'}, {id:3,mode:'new_article',status:'queued',blog_id:'b',topic:'t',payload_json:'{"language":"ko"}'}, {fetchImpl,saveState:async(s)=>states.push(s)});
  assert.deepEqual(states,['writing','repairing','critic_review','ready']);
  assert.equal(out.state,'ready');
  assert.equal(out.result.repairAttempts,2);
});

test('stored new-article job regenerates only after three targeted repairs are exhausted', async () => {
  const states=[];
  const issue={code:'READABILITY',severity:'MEDIUM',location:'html p 1',reason:'still weak',repairInstruction:'repair only html p 1'};
  const first={...article,html:'<p>Problem.</p>'};
  const repair1={...article,html:'<p>Problem one.</p>'};
  const repair2={...article,html:'<p>Problem two.</p>'};
  const repair3={...article,html:'<p>Problem three.</p>'};
  const fresh={...article,html:'<p>Fresh concise answer.</p>'};
  const fetchImpl=router([
    {article:first},
    {status:'FAIL',score:86,issues:[issue]},
    {article:repair1},
    {status:'FAIL',score:88,issues:[issue]},
    {article:repair2},
    {status:'FAIL',score:90,issues:[issue]},
    {article:repair3},
    {status:'FAIL',score:91,issues:[issue]},
    {article:fresh},
    {status:'PASS',score:98,issues:[]}
  ]);
  const out=await processStoredJob({API_HUB_BASE_URL:'https://hub',HUB_API_KEY:'k'}, {id:4,mode:'new_article',status:'queued',blog_id:'b',topic:'t',payload_json:'{"language":"ko"}'}, {fetchImpl,saveState:async(s)=>states.push(s)});
  assert.deepEqual(states,[
    'writing','critic_review','repairing','final_critic','repairing','final_critic','repairing','final_critic','writing','critic_review','ready'
  ]);
  assert.equal(out.state,'ready');
  assert.equal(out.result.candidateRegenerated,true);
  assert.equal(out.result.candidateAttempt,2);
});

test('existing post is fully rewritten then becomes ready for same-post update', async () => {
  const states=[];
  const rewritten={...article,title:'T - Updated',html:'<p>fresh complete rewrite</p>'};
  const fetchImpl=router([
    {blogId:'b',bloggerPostId:'p',article},
    {article:rewritten},
    {status:'PASS',score:98,issues:[]}
  ]);
  const out=await processStoredJob({API_HUB_BASE_URL:'https://hub',HUB_API_KEY:'k'}, {id:2,mode:'repair_existing',status:'queued',blog_id:'b',blogger_post_id:'p',payload_json:'{}'}, {fetchImpl,saveState:async(s)=>states.push(s)});
  assert.deepEqual(states,['writing','critic_review','ready']);
  assert.equal(out.result.status,'READY_TO_UPDATE_EXISTING');
  assert.equal(out.result.identity.bloggerPostId,'p');
  assert.equal(out.result.rewriteMode,'full_article_same_post_id');
});

test('failed stored jobs persist only a safe error code and never provider text', async () => {
  const states=[];
  const fetchImpl=async () => new Response(JSON.stringify({ error:'SENSITIVE_PROVIDER_BODY_SHOULD_NOT_PERSIST' }), { status:502 });
  await assert.rejects(
    processStoredJob(
      {API_HUB_BASE_URL:'https://hub',HUB_API_KEY:'k'},
      {id:9,mode:'new_article',status:'queued',blog_id:'b',topic:'t',payload_json:'{"language":"ko"}'},
      {fetchImpl,saveState:async(state,patch)=>states.push({state,patch})}
    )
  );
  const failed=states.find((item)=>item.state==='failed');
  assert.ok(failed);
  assert.match(String(failed.patch?.error || ''), /^[A-Z0-9_]+$/);
  assert.doesNotMatch(JSON.stringify(failed), /SENSITIVE_PROVIDER_BODY_SHOULD_NOT_PERSIST/);
});
