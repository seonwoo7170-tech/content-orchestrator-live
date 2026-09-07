import { requireAuthorized } from './lib/auth.js';
import { json, readJson, MASTER_V45 } from './lib/contracts.js';
import { critic, diagnostic, repair, writer } from './lib/ai-routes.js';
import { generateImage } from './lib/image-routes.js';
import { modelScopeConfigured } from './lib/modelscope-image.js';
import { geminiRequestTimeoutMs } from './lib/gemini-ai.js';
import { freeAiConfigured, freeAiFallbackEnabled, freeAiModel } from './lib/free-ai.js';
import { masterV45RuntimeStatus } from './lib/master-v45-bundle.js';
import { masterV45RolePromptRuntimeStatus } from './lib/master-v45-role-prompts.js';
import {
  buildGoogleAuthorizationUrl,
  completeGoogleOAuthSetup,
  googleOAuthClientConfigured,
  googleOAuthConfigured,
  googleOAuthScopeUpgradeEnabled,
  googleOAuthSetupEnabled
} from './lib/google-oauth.js';
import { getGoogleScopeStatus } from './lib/google-scopes.js';
import { listSearchConsoleSites, querySearchConsolePerformance } from './lib/search-console.js';
import { listAnalyticsProperties, queryAnalyticsReport } from './lib/google-analytics.js';
import { listAdsenseAccounts, listAdsenseSites, queryAdsenseReport } from './lib/google-adsense.js';
import { getPost, listBlogs, writePost } from './lib/blogger.js';
import { listPosts } from './lib/blogger-posts.js';
import { planTopic } from './lib/topic-planner.js';
import { assertBloggerWriteAllowed } from './lib/write-policy.js';
import { tavilyConfigured, tavilySearch } from './lib/tavily-search.js';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textProviderOrder(env, forceGeminiPrimary = false) {
  const primary = forceGeminiPrimary
    ? 'gemini'
    : String(env.TEXT_PRIMARY_PROVIDER || 'cloudflare').trim().toLowerCase();
  const geminiConfigured = Boolean(String(env.GEMINI_API_KEY || '').trim());
  const freeAiEnabled = freeAiFallbackEnabled(env) && freeAiConfigured(env);
  const cloudflareFallbackEnabled = String(env.TEXT_CLOUDFLARE_FALLBACK_ENABLED || 'false').trim().toLowerCase() === 'true';
  if (primary === 'gemini') {
    return [
      'google-gemini',
      ...(freeAiEnabled ? ['free-ai'] : []),
      ...(cloudflareFallbackEnabled ? ['cloudflare-workers-ai'] : [])
    ];
  }
  return geminiConfigured
    ? ['cloudflare-workers-ai', 'google-gemini']
    : ['cloudflare-workers-ai'];
}

function oauthTokenPage(refreshToken) {
  const token = escapeHtml(refreshToken);
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Hub v2 Google OAuth</title></head><body>
<main style="max-width:760px;margin:40px auto;padding:20px;font-family:system-ui,sans-serif;line-height:1.6">
<h1>Google OAuth 연결 승인 완료</h1>
<p>아래 refresh token은 이 화면에서만 확인하세요. 채팅이나 캡처로 보내지 말고 GitHub production environment secret <strong>API_HUB_V2_GOOGLE_REFRESH_TOKEN</strong>에 직접 저장하세요.</p>
<textarea readonly style="width:100%;min-height:180px;box-sizing:border-box">${token}</textarea>
<p>저장한 뒤 API Hub v2를 다시 배포하면 OAuth 설정용 엔드포인트는 자동으로 비활성화됩니다.</p>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'pragma': 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const geminiConfigured = Boolean(String(env.GEMINI_API_KEY || '').trim());
        const freeAiIsConfigured = freeAiConfigured(env);
        const freeAiIsEnabled = freeAiFallbackEnabled(env) && freeAiIsConfigured;
        const modelScopeIsConfigured = modelScopeConfigured(env);
        const kieConfigured = Boolean(String(env.KIE_API_KEY || '').trim());
        const imageQaRequired = String(env.IMAGE_QA_REQUIRED || 'false').trim().toLowerCase() === 'true';
        const writerProviderOrder = textProviderOrder(env);
        const criticProviderOrder = textProviderOrder(env, true);
        const repairProviderOrder = textProviderOrder(env);
        const textPrimaryProvider = writerProviderOrder[0];
        const textCloudflareFallbackEnabled = String(env.TEXT_CLOUDFLARE_FALLBACK_ENABLED || 'false').trim().toLowerCase() === 'true';
        const imageProviderOrder = [
          ...(modelScopeIsConfigured ? ['modelscope'] : []),
          ...(kieConfigured ? ['kie-ai'] : []),
          'cloudflare-workers-ai'
        ];
        return json({
          ok: true,
          service: 'api-hub-v2',
          auth: 'x-hub-api-key',
          textPrimaryProvider,
          textCloudflareFallbackEnabled,
          geminiRequestTimeoutMs: geminiRequestTimeoutMs(env),
          freeAiConfigured: freeAiIsConfigured,
          freeAiFallbackEnabled: freeAiIsEnabled,
          freeAiModel: freeAiModel(env),
          freeAiWriterModel: freeAiModel(env, 'writer'),
          freeAiCriticModel: freeAiModel(env, 'critic'),
          freeAiRepairModel: freeAiModel(env, 'repair'),
          writerModel: env.WRITER_MODEL || '@cf/openai/gpt-oss-120b',
          writerProviderOrder,
          writerResearchProvider: 'tavily',
          writerResearchMode: 'auto',
          topicPlanner: 'conservative-evergreen',
          bloggerPostInventory: 'read-only-metadata',
          tavilyConfigured: tavilyConfigured(env),
          tavilySearchDepth: 'basic',
          criticProvider: 'google-gemini',
          criticProviderOrder,
          criticFallbackEnabled: criticProviderOrder.length > 1,
          criticModel: env.GEMINI_CRITIC_MODEL || 'gemini-3.5-flash-lite',
          criticConfigured: geminiConfigured,
          criticAuditMode: 'master-v4.5-role-critic-gemini-granular',
          repairModel: env.REPAIR_MODEL || '@cf/openai/gpt-oss-120b',
          repairProviderOrder,
          imageProvider: imageProviderOrder[0],
          imageProviderOrder,
          imageModel: env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell',
          imageConfigured: Boolean(env.AI) || kieConfigured || modelScopeIsConfigured,
          imageQaRequired,
          imageQaConfigured: imageQaRequired && geminiConfigured,
          imageQaProvider: 'google-gemini',
          imageQaModel: env.GEMINI_IMAGE_QA_MODEL || env.GEMINI_CRITIC_MODEL || 'gemini-3.5-flash-lite',
          imageQaMaxAttempts: Number(env.IMAGE_QA_MAX_ATTEMPTS || 3),
          modelScopeImageConfigured: modelScopeIsConfigured,
          modelScopeImageModel: env.MODELSCOPE_IMAGE_MODEL || 'Tongyi-MAI/Z-Image-Turbo',
          kieImageConfigured: kieConfigured,
          kieImageModel: env.KIE_IMAGE_MODEL || 'z-image',
          geminiConfigured,
          geminiFallbackConfigured: geminiConfigured,
          geminiWriterModel: env.GEMINI_WRITER_MODEL || 'gemini-3.5-flash-lite',
          geminiCriticModel: env.GEMINI_CRITIC_MODEL || 'gemini-3.5-flash-lite',
          geminiRepairModel: env.GEMINI_REPAIR_MODEL || 'gemini-3.5-flash-lite',
          googleOAuthClientConfigured: googleOAuthClientConfigured(env),
          googleOAuthSetupEnabled: googleOAuthSetupEnabled(env),
          googleOAuthScopeUpgradeEnabled: googleOAuthScopeUpgradeEnabled(env),
          bloggerConfigured: googleOAuthConfigured(env),
          phase4GoogleData: {
            scopeProbe: '/api/google/scopes',
            searchConsoleSites: '/api/gsc/sites',
            searchConsolePerformance: '/api/gsc/performance',
            analyticsProperties: '/api/ga4/properties',
            analyticsReport: '/api/ga4/report',
            adsenseAccounts: '/api/adsense/accounts',
            adsenseSites: '/api/adsense/sites',
            adsenseReport: '/api/adsense/report'
          },
          bloggerWritesEnabled: env.BLOGGER_WRITES_ENABLED === 'true',
          bloggerWriteMode: String(env.BLOGGER_WRITE_MODE || 'disabled'),
          masterV45: await masterV45RuntimeStatus(),
          rolePrompts: await masterV45RolePromptRuntimeStatus()
        });
      }

      if (request.method === 'GET' && url.pathname === '/oauth/google/start') {
        return Response.redirect(await buildGoogleAuthorizationUrl(env, request.url), 302);
      }

      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') {
        const { refreshToken } = await completeGoogleOAuthSetup(env, request.url);
        return oauthTokenPage(refreshToken);
      }

      requireAuthorized(request, env);

      if (request.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

      if (url.pathname === '/api/google/scopes') return json(await getGoogleScopeStatus(env));
      if (url.pathname === '/api/gsc/sites') return json(await listSearchConsoleSites(env));
      if (url.pathname === '/api/gsc/performance') return json(await querySearchConsolePerformance(env, await readJson(request)));
      if (url.pathname === '/api/ga4/properties') return json(await listAnalyticsProperties(env));
      if (url.pathname === '/api/ga4/report') return json(await queryAnalyticsReport(env, await readJson(request)));
      if (url.pathname === '/api/adsense/accounts') return json(await listAdsenseAccounts(env));
      if (url.pathname === '/api/adsense/sites') return json(await listAdsenseSites(env, await readJson(request)));
      if (url.pathname === '/api/adsense/report') return json(await queryAdsenseReport(env, await readJson(request)));

      if (url.pathname === '/api/hub/ai/diagnostics/cloudflare') {
        const result = await diagnostic(env);
        return json(result, result.ok ? 200 : 502);
      }
      if (url.pathname === '/api/hub/search/tavily') return json(await tavilySearch(env, await readJson(request)));
      if (url.pathname === '/api/hub/ai/topic') return json(await planTopic(env, await readJson(request)));
      if (url.pathname === '/api/hub/ai/writer') return json(await writer(env, await readJson(request)));
      if (url.pathname === '/api/hub/ai/critic') return json(await critic(env, await readJson(request)));
      if (url.pathname === '/api/hub/ai/repair') return json(await repair(env, await readJson(request)));
      if (url.pathname === '/api/hub/image/generate') return json(await generateImage(env, await readJson(request)));
      if (url.pathname === '/api/blogger/blogs') return json(await listBlogs(env));
      if (url.pathname === '/api/blogger/posts') return json(await listPosts(env, await readJson(request)));
      if (url.pathname === '/api/blogger/post/get') return json(await getPost(env, await readJson(request)));
      if (url.pathname === '/api/blogger/post') {
        const input = await readJson(request);
        assertBloggerWriteAllowed(env, input);
        return json(await writePost(env, input));
      }

      return json({ ok: false, error: 'NOT_FOUND' }, 404);
    } catch (error) {
      const status = Number(error?.status || 500);
      const body = { ok: false, error: String(error?.message || 'INTERNAL_ERROR') };
      if (Number.isInteger(error?.providerCode)) body.providerCode = error.providerCode;
      if (Number.isInteger(error?.providerHttpStatus)) body.providerHttpStatus = error.providerHttpStatus;
      if (Number.isInteger(error?.providerStatus)) body.providerStatus = error.providerStatus;
      if (typeof error?.providerValidationHint === 'string' && /^[A-Za-z0-9_./,:; -]{1,240}$/.test(error.providerValidationHint)) body.providerValidationHint = error.providerValidationHint;
      if (Number.isInteger(error?.qaAttempts)) body.qaAttempts = error.qaAttempts;
      if (Number.isInteger(error?.qaViolationCount)) body.qaViolationCount = error.qaViolationCount;
      if (Number.isInteger(error?.qaDetectedTextCount)) body.qaDetectedTextCount = error.qaDetectedTextCount;
      if (Array.isArray(error?.qaDetectedText) && error.qaDetectedText.length) body.qaDetectedText = error.qaDetectedText.map((item) => String(item).slice(0, 100)).slice(0, 8);
      if (Array.isArray(error?.qaViolations) && error.qaViolations.length) body.qaViolations = error.qaViolations.map((item) => String(item).slice(0, 100)).slice(0, 8);
      if (String(error?.message || '') === 'IMAGE_QA_REJECTED' && /^https:\/\//i.test(String(error?.rejectedImageUrl || ''))) {
        body.rejectedImageUrl = String(error.rejectedImageUrl);
        body.rejectedImageMimeType = String(error.rejectedImageMimeType || 'image/jpeg');
        body.rejectedProvider = 'kie-ai';
        body.rejectedModel = String(error.rejectedModel || 'z-image').slice(0, 80);
        body.rejectedTaskId = String(error.rejectedTaskId || '').slice(0, 120);
      }
      if (error?.meta === MASTER_V45) body.masterV45 = MASTER_V45;
      return json(body, status);
    }
  }
};