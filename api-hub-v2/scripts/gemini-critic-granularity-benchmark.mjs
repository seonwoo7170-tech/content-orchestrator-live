import { runGeminiAi } from '../src/lib/gemini-ai.js';
import { loadMasterV45RolePrompt } from '../src/lib/master-v45-role-prompts.js';
import { parseJsonText } from '../src/lib/contracts.js';

const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) throw new Error('GEMINI_API_KEY_REQUIRED');

const rolePrompt = await loadMasterV45RolePrompt('critic');

const schema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['PASS', 'FAIL'] },
    score: { type: 'number', minimum: 0, maximum: 100 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          location: { type: 'string' },
          reason: { type: 'string' },
          repairInstruction: { type: 'string' }
        },
        required: ['code', 'severity', 'location', 'reason', 'repairInstruction']
      }
    }
  },
  required: ['status', 'score', 'issues']
};

const addon = `\n\n--- GRANULAR CRITIC PASS ---\nAudit the article in separate passes. Do not collapse materially different violations into one issue. A distinct repair action must receive a distinct issue. Independently inspect: (1) title exaggeration/clickbait or guarantees, (2) unsupported absolute claims, (3) fabricated or unsupported statistics, (4) fabricated, placeholder, or invalid sources/URLs, (5) unsafe or destructive instructions, (6) repetition/filler, (7) malformed or unsafe HTML, (8) misleading search description, and (9) other applicable Master v4.5 violations. Consolidate only exact duplicates of the same defect. Return all concrete issues you can support from the supplied Article itself. PASS requires score >=95 and zero issues.`;

const systemInstruction = `${rolePrompt.text}${addon}`;
const article = {
  title: '컴퓨터가 느리면 무조건 레지스트리를 삭제하세요 — 속도 300% 보장',
  html: '<section><p>모든 PC는 이 방법으로 반드시 300% 빨라집니다.</p><p>2026년 세계 PC 연구소 조사에서 사용자 97.3%가 효과를 봤습니다.</p><h2>해결 방법</h2><p>Windows 폴더와 레지스트리 항목을 확인 없이 삭제하면 됩니다.</p><p>이 방법은 완벽합니다. 이 방법은 완벽합니다. 이 방법은 완벽합니다.</p><div><p>닫히지 않은 HTML 구조입니다.</section>',
  searchDescription: 'PC를 무조건 300% 빠르게 만드는 완벽한 방법',
  labels: ['PC', '속도'],
  sources: [{ name: '세계 PC 연구소', url: 'https://example.invalid/fake-study' }],
  language: 'ko',
  topic: 'PC 속도 개선'
};

const result = await runGeminiAi({ GEMINI_API_KEY: apiKey }, {
  model: 'gemini-3.5-flash-lite',
  systemInstruction,
  userContent: JSON.stringify({ article }),
  maxOutputTokens: 4096,
  responseSchema: schema,
  thinking: 'medium'
});

const parsed = parseJsonText(result.response);
const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
console.log(JSON.stringify({
  mode: 'critic-granularity-benchmark',
  provider: 'google-gemini',
  model: result.model,
  status: parsed.status,
  score: parsed.score,
  issueCount: issues.length,
  issues: issues.map((issue) => ({
    code: String(issue.code || ''),
    severity: String(issue.severity || ''),
    location: String(issue.location || '')
  })),
  usage: result.usage,
  rolePrompt: rolePrompt.meta,
  writes: false
}, null, 2));

if (parsed.status !== 'FAIL') throw new Error('GEMINI_GRANULAR_CRITIC_DID_NOT_FAIL');
if (issues.length < 6) throw new Error(`GEMINI_GRANULAR_CRITIC_TOO_FEW_ISSUES:${issues.length}`);
