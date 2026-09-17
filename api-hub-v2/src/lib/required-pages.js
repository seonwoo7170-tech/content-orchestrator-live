import { parseJsonText } from './contracts.js';
import { loadMasterV45 } from './master-v45-bundle.js';
import { runPrimaryWithGeminiFallback } from './ai-provider-router.js';

const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const OUTPUT_TOKEN_BUDGET = 4096;
const ALLOWED_LANGUAGES = new Set(['ko', 'en']);

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}

// This adapter asks the model for the two pages that genuinely benefit from being written in the
// blog's own voice (About, Contact). The Privacy Policy is handled separately below as a fixed
// boilerplate plus one short AI-written intro paragraph: AdSense reviewers check for specific
// disclosure language (cookies, third-party ad vendors, opt-out links), so the legally load-bearing
// text must not be left to free-form generation.
const REQUIRED_PAGES_ADAPTER = `AUTOMATION REQUIRED-PAGES ADAPTER — this adapter overrides any interactive/questioning flow in the master prompt for this server call.
Platform is Google Blogger / Blogspot. Do not ask questions. Produce content for exactly two static informational pages for the blog described below: "About" and "Contact". These are not blog posts; do not use a listicle or SEO-article structure, do not invent a search topic, and do not add headings that imply this is an article.
Tailor both pages specifically to the supplied blog name and theme/purpose. Do not write generic boilerplate that could apply to any blog — reference what this specific blog actually covers.
About page: 2-4 short paragraphs. State what the blog covers, who it is useful for, and the general approach or perspective the blog takes. Do not fabricate specific credentials, company history, awards, or team members that were not supplied. If no author/team detail was supplied, speak in terms of the blog's editorial focus and interest rather than inventing a biography.
Contact page: 1-2 short paragraphs inviting readers to reach out (feedback, corrections, inquiries), plus a short line noting the contact email will be inserted separately. Do not invent a physical address, phone number, or contact email yourself.
Also write ONE short paragraph (2-4 sentences, in the requested language) introducing this specific blog for the Privacy Policy page — what kind of site it is and what it is generally about. Do not write about cookies, advertising, or data collection in this paragraph; that boilerplate is added separately.
Return JSON only with this exact shape: {"about":{"title":"...","html":"..."},"contact":{"title":"...","html":"..."},"privacyIntro":"..."}. The html fields must contain only the page body (no <html>/<head>/<body>), using <p> paragraphs only — no headings, since the Blogger page title already provides one. Write in the requested language only.`;

function validatePagesShape(value) {
  const parsed = value && typeof value === 'object' ? value : null;
  if (!parsed) throw Object.assign(new Error('REQUIRED_PAGES_SCHEMA_INVALID'), { status: 502 });
  for (const key of ['about', 'contact']) {
    const page = parsed[key];
    if (!page || typeof page !== 'object' || typeof page.title !== 'string' || !page.title.trim() || typeof page.html !== 'string' || !page.html.trim()) {
      throw Object.assign(new Error(`REQUIRED_PAGES_${key.toUpperCase()}_INVALID`), { status: 502 });
    }
  }
  if (typeof parsed.privacyIntro !== 'string' || !parsed.privacyIntro.trim()) {
    throw Object.assign(new Error('REQUIRED_PAGES_PRIVACY_INTRO_INVALID'), { status: 502 });
  }
  return parsed;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fixed disclosure boilerplate. Kept out of model generation on purpose: AdSense approval and
// most ad-network review processes check for this exact substance (cookies, named third-party ad
// vendors, an opt-out link, a children's-privacy line), so it must be reliably present and correct
// rather than left to a language model's judgment on any given run.
function privacyPolicyHtml(language, { blogName, blogUrl, contactEmail, intro }) {
  const introHtml = `<p>${escapeHtml(intro)}</p>`;
  const site = escapeHtml(blogName);
  const url = escapeHtml(blogUrl);
  const email = contactEmail ? escapeHtml(contactEmail) : null;

  if (language === 'en') {
    return `${introHtml}
<p>This Privacy Policy explains what information is collected when you visit ${site} (${url}) and how it is used.</p>
<p><strong>Log data and cookies.</strong> Like most websites, this site collects standard log information (browser type, pages visited, time spent, referring pages) and uses cookies to operate correctly and to understand how visitors use the site.</p>
<p><strong>Advertising and third-party vendors.</strong> This site displays advertisements served by Google AdSense and other third-party advertising vendors. These vendors, including Google, use cookies (such as the DoubleClick DART cookie) to serve ads based on a visitor's prior visits to this site or other sites on the internet. Google's use of advertising cookies enables it and its partners to serve ads based on your visits to this site and/or other sites on the internet.</p>
<p>You may opt out of personalized advertising by visiting <a href="https://adssettings.google.com" rel="nofollow noopener" target="_blank">Google Ads Settings</a>. Alternatively, you can opt out of a third-party vendor's use of cookies for personalized advertising by visiting <a href="https://www.aboutads.info/choices/" rel="nofollow noopener" target="_blank">www.aboutads.info</a>.</p>
<p><strong>Children's privacy.</strong> This site does not knowingly collect personal information from children under 13. This site does not specifically target content to children under 13.</p>
<p><strong>Changes to this policy.</strong> This Privacy Policy may be updated from time to time. Continued use of this site after changes are posted constitutes acceptance of those changes.</p>
${email ? `<p>If you have questions about this Privacy Policy, contact us at <a href="mailto:${email}">${email}</a>.</p>` : ''}`;
  }

  return `${introHtml}
<p>본 개인정보처리방침은 ${site}(${url}) 방문 시 수집되는 정보와 그 이용 방법을 설명합니다.</p>
<p><strong>로그 데이터 및 쿠키.</strong> 대부분의 웹사이트와 마찬가지로 이 사이트는 방문자의 브라우저 종류, 방문 페이지, 체류 시간, 유입 경로 등 일반적인 로그 정보를 수집하며, 사이트를 정상적으로 운영하고 방문자의 이용 방식을 파악하기 위해 쿠키를 사용합니다.</p>
<p><strong>광고 및 제3자 광고 업체.</strong> 이 사이트는 Google 애드센스(Google AdSense) 및 기타 제3자 광고 업체가 제공하는 광고를 게재합니다. Google을 포함한 이들 업체는 DoubleClick DART 쿠키 등을 사용하여, 방문자가 이 사이트 또는 인터넷상의 다른 사이트를 방문한 이력을 바탕으로 광고를 게재할 수 있습니다.</p>
<p>맞춤형 광고를 원하지 않으시면 <a href="https://adssettings.google.com" rel="nofollow noopener" target="_blank">Google 광고 설정</a>에서 설정을 변경하실 수 있습니다. 또한 <a href="https://www.aboutads.info/choices/" rel="nofollow noopener" target="_blank">www.aboutads.info</a>에서도 제3자 업체의 맞춤형 광고 쿠키 사용을 거부할 수 있습니다.</p>
<p><strong>아동의 개인정보.</strong> 이 사이트는 만 13세 미만 아동의 개인정보를 고의로 수집하지 않으며, 만 13세 미만 아동을 대상으로 콘텐츠를 제공하지 않습니다.</p>
<p><strong>방침의 변경.</strong> 본 개인정보처리방침은 수시로 변경될 수 있으며, 변경 사항 게시 이후 사이트를 계속 이용하는 경우 해당 변경에 동의한 것으로 간주됩니다.</p>
${email ? `<p>본 방침에 대해 문의사항이 있으시면 <a href="mailto:${email}">${email}</a>로 연락해 주세요.</p>` : ''}`;
}

export async function generateRequiredPages(env, input = {}, aiBinding = env?.AI, fetchImpl = fetch) {
  const blogName = required(input?.blogName, 'BLOG_NAME');
  const blogUrl = required(input?.blogUrl, 'BLOG_URL');
  const topic = required(input?.topic, 'TOPIC');
  const language = String(input?.language || '').trim();
  if (!ALLOWED_LANGUAGES.has(language)) throw Object.assign(new Error('REQUIRED_PAGES_LANGUAGE_INVALID'), { status: 400 });
  const contactEmail = input?.contactEmail ? String(input.contactEmail).trim() : '';

  const masterText = await loadMasterV45();
  const systemInstruction = `${masterText}\n\n--- REQUIRED PAGES ADAPTER ---\n${REQUIRED_PAGES_ADAPTER}`;
  const userContent = JSON.stringify({ platform: 'Blogger', blogName, blogUrl, topic, language });

  const cloudflareModel = env.WRITER_MODEL || '@cf/openai/gpt-oss-120b';
  const geminiModel = env.GEMINI_WRITER_MODEL || GEMINI_DEFAULT_MODEL;

  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET,
      thinking: 'minimal'
    }
  }, aiBinding, fetchImpl, (parsed) => validatePagesShape(parsed));

  let parsed;
  try { parsed = parseJsonText(result.response); } catch {
    throw Object.assign(new Error('REQUIRED_PAGES_JSON_INVALID'), { status: 502 });
  }
  const validated = validatePagesShape(parsed);

  return {
    pages: [
      {
        type: 'privacy-policy',
        title: language === 'en' ? 'Privacy Policy' : '개인정보처리방침',
        html: privacyPolicyHtml(language, { blogName, blogUrl, contactEmail, intro: validated.privacyIntro })
      },
      { type: 'about', title: validated.about.title, html: validated.about.html },
      { type: 'contact', title: validated.contact.title, html: validated.contact.html }
    ],
    model: result.model,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed
  };
}
