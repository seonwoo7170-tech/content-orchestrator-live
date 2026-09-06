import { writer, critic, repair } from '../src/lib/ai-routes.js';

function exhaustedWorkersAi() {
  return {
    async run() {
      const error = new Error('3036 daily free allocation exhausted');
      error.code = 3036;
      throw error;
    }
  };
}

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name}_REQUIRED`);
  return text;
}

function safeIssueSummary(issues) {
  return (Array.isArray(issues) ? issues : []).map((issue) => ({
    code: String(issue?.code || ''),
    severity: String(issue?.severity || ''),
    location: String(issue?.location || '')
  }));
}

function env() {
  return {
    GEMINI_API_KEY: required(process.env.GEMINI_API_KEY, 'GEMINI_API_KEY'),
    GEMINI_WRITER_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_CRITIC_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_REPAIR_MODEL: 'gemini-3.5-flash-lite'
  };
}

async function runFaultInjection(runtimeEnv) {
  const article = {
    title: '컴퓨터가 느리면 무조건 레지스트리를 삭제하세요 — 속도 300% 보장',
    html: '<section><p>모든 PC는 이 방법으로 반드시 300% 빨라집니다.</p><p>2026년 세계 PC 연구소 조사에서 사용자 97.3%가 효과를 봤습니다.</p><h2>해결 방법</h2><p>Windows 폴더와 레지스트리 항목을 확인 없이 삭제하면 됩니다.</p><p>이 방법은 완벽합니다. 이 방법은 완벽합니다. 이 방법은 완벽합니다.</p><div><p>닫히지 않은 HTML 구조입니다.</section>',
    searchDescription: 'PC를 무조건 300% 빠르게 만드는 완벽한 방법',
    labels: ['PC', '속도'],
    sources: [{ name: '세계 PC 연구소', url: 'https://example.invalid/fake-study' }],
    language: 'ko',
    topic: 'PC 속도 개선'
  };

  const result = await critic(
    runtimeEnv,
    { article, stage: 'fault-injection' },
    exhaustedWorkersAi(),
    fetch
  );

  console.log(JSON.stringify({
    mode: 'critic-fault',
    provider: result.provider,
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    primaryError: result.primaryError,
    status: result.status,
    score: result.score,
    issueCount: result.issues.length,
    issues: safeIssueSummary(result.issues),
    rolePrompt: result.rolePrompt,
    auditMode: result.auditMode,
    usage: result.usage,
    writes: false
  }, null, 2));

  if (result.provider !== 'google-gemini' || result.fallbackUsed) throw new Error('GEMINI_DEDICATED_CRITIC_NOT_USED');
  if (result.auditMode !== 'master-v4.5-role-critic-gemini-granular') throw new Error('GEMINI_GRANULAR_CRITIC_MODE_MISSING');
  if (result.status !== 'FAIL' || result.issues.length < 6) throw new Error(`GEMINI_CRITIC_TOO_WEAK:${result.issues.length}`);
}

async function runPipeline(runtimeEnv) {
  const topic = String(process.env.DRYRUN_TOPIC || 'PC가 갑자기 느려졌을 때 초보자가 확인할 순서').trim();
  const language = String(process.env.DRYRUN_LANGUAGE || 'ko').trim();
  if (!['ko', 'en'].includes(language)) throw new Error('DRYRUN_LANGUAGE_INVALID');

  const writerResult = await writer(
    runtimeEnv,
    { blogId: 'NO_WRITE_DRYRUN', topic, language },
    exhaustedWorkersAi(),
    fetch
  );
  const initial = await critic(
    runtimeEnv,
    { article: writerResult.article, stage: 'initial' },
    exhaustedWorkersAi(),
    fetch
  );

  let repaired = null;
  let finalCritic = initial;
  if (initial.status === 'FAIL') {
    repaired = await repair(
      runtimeEnv,
      { article: writerResult.article, issues: initial.issues },
      exhaustedWorkersAi(),
      fetch
    );
    finalCritic = await critic(
      runtimeEnv,
      { article: repaired.article, stage: 'final' },
      exhaustedWorkersAi(),
      fetch
    );
  }

  console.log(JSON.stringify({
    mode: 'pipeline',
    topic,
    language,
    writer: {
      provider: writerResult.provider,
      model: writerResult.model,
      fallbackUsed: writerResult.fallbackUsed,
      titleLength: writerResult.article.title.length,
      htmlChars: writerResult.article.html.length,
      rolePrompt: writerResult.rolePrompt
    },
    initialCritic: {
      provider: initial.provider,
      model: initial.model,
      status: initial.status,
      score: initial.score,
      issueCount: initial.issues.length,
      issues: safeIssueSummary(initial.issues),
      rolePrompt: initial.rolePrompt,
      auditMode: initial.auditMode
    },
    repair: repaired ? {
      provider: repaired.provider,
      model: repaired.model,
      htmlChars: repaired.article.html.length,
      rolePrompt: repaired.rolePrompt
    } : null,
    finalCritic: {
      provider: finalCritic.provider,
      model: finalCritic.model,
      status: finalCritic.status,
      score: finalCritic.score,
      issueCount: finalCritic.issues.length,
      issues: safeIssueSummary(finalCritic.issues),
      auditMode: finalCritic.auditMode
    },
    writes: false
  }, null, 2));

  if (writerResult.provider !== 'google-gemini' || initial.provider !== 'google-gemini') {
    throw new Error('GEMINI_PIPELINE_PROVIDER_CONTRACT_FAILED');
  }
  if (initial.fallbackUsed) throw new Error('CRITIC_MUST_NOT_BE_A_FALLBACK');
  if (finalCritic.status !== 'PASS') throw new Error('GEMINI_PIPELINE_NOT_READY');
}

const runtimeEnv = env();
const mode = String(process.env.DRYRUN_MODE || 'critic-fault').trim();
if (mode === 'critic-fault') {
  await runFaultInjection(runtimeEnv);
} else if (mode === 'pipeline') {
  await runPipeline(runtimeEnv);
} else {
  throw new Error('DRYRUN_MODE_INVALID');
}
