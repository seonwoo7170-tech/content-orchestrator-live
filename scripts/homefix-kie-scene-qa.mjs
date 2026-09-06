import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildImagePlan } from '../worker/lib/image-plan.js';

const baseUrl = String(process.env.API_HUB_V2_BASE_URL || '').replace(/\/$/, '');
const hubKey = String(process.env.HUB_API_KEY || '').trim();
if (!baseUrl || !hubKey) throw new Error('PROBE_CONFIG_MISSING');

const outDir = path.resolve('.kie-scene-probe');
fs.mkdirSync(outDir, { recursive: true });

const articles = [
  {
    title: 'How to Find and Test Your Main Water Shutoff Before an Emergency',
    topic: 'How to Find and Test Your Main Water Shutoff Before an Emergency',
    language: 'en',
    html: '<p>Locate the valve.</p>'
  },
  {
    title: 'Low Shower Water Pressure: 5 Things to Check at Home First',
    topic: 'Low Shower Water Pressure: 5 Things to Check at Home First',
    language: 'en',
    html: '<p>Inspect the showerhead.</p>'
  },
  {
    title: 'Using AI Assistants Safely for Home Maintenance: A Practical Guide',
    topic: 'Using AI Assistants Safely for Home Maintenance: A Practical Guide',
    language: 'en',
    html: '<p>Use AI as a planning aid.</p>'
  }
];

const requestedLimit = Number(process.env.KIE_SCENE_QA_LIMIT || articles.length);
const qaLimit = Number.isInteger(requestedLimit) && requestedLimit >= 1
  ? Math.min(requestedLimit, articles.length)
  : articles.length;
const requestedIndex = Number(process.env.KIE_SCENE_QA_INDEX || 1);
const qaStartIndex = Number.isInteger(requestedIndex) && requestedIndex >= 1 && requestedIndex <= articles.length
  ? requestedIndex - 1
  : 0;
const probeArticles = articles
  .map((article, index) => ({ article, sourceIndex: index + 1 }))
  .slice(qaStartIndex, qaStartIndex + qaLimit);

async function health(label) {
  const response = await fetch(`${baseUrl}/health?kie_scene_probe=${label}_${Date.now()}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HEALTH_${response.status}`);
  if (data.bloggerWritesEnabled !== false || data.bloggerWriteMode !== 'disabled') throw new Error('BLOGGER_WRITE_GATE_NOT_OFF');
  return {
    imageQaRequired: data.imageQaRequired === true,
    imageQaConfigured: data.imageQaConfigured === true,
    imageQaProvider: String(data.imageQaProvider || ''),
    imageQaModel: String(data.imageQaModel || ''),
    imageQaMaxAttempts: Number(data.imageQaMaxAttempts || 0),
    bloggerWritesEnabled: data.bloggerWritesEnabled,
    bloggerWriteMode: String(data.bloggerWriteMode || '')
  };
}

function normalizedOcrToken(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '');
}

function detectText(file) {
  const result = spawnSync('tesseract', [file, 'stdout', '--psm', '11', '-l', 'eng', 'tsv'], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const lines = String(result.stdout || '').split(/\r?\n/);
  const words = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 12) continue;
    const confidence = Number(parts[10]);
    const text = parts.slice(11).join('\t').trim();
    if (!text) continue;
    words.push({ text, confidence: Number.isFinite(confidence) ? confidence : -1 });
  }
  const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
  const tokens = text.match(/[A-Za-z0-9]{2,}/g) || [];
  const alnumCount = tokens.join('').replace(/[^A-Za-z0-9]/g, '').length;
  const highConfidenceWords = words
    .filter((word) => word.confidence >= 60 && /[A-Za-z0-9]/.test(word.text))
    .slice(0, 12);
  const meaningfulWords = words
    .map((word) => ({ ...word, normalized: normalizedOcrToken(word.text) }))
    .filter((word) => {
      if (word.confidence < 75) return false;
      if (/^[A-Za-z]{3,}$/.test(word.normalized)) return true;
      if (/^\d{2,}$/.test(word.normalized)) return true;
      return /^[A-Za-z0-9]{4,}$/.test(word.normalized);
    })
    .slice(0, 12);
  return {
    text: text.slice(0, 160),
    alnumCount,
    rejected: meaningfulWords.length > 0,
    highConfidenceWords,
    meaningfulWords
  };
}

let rejected = 0;
let fatalError = null;
const results = [];
let beforeGateConfirmed = false;
let afterGateConfirmed = false;
let healthBefore = null;
let healthAfter = null;

try {
  healthBefore = await health('before');
  beforeGateConfirmed = true;

  for (const selected of probeArticles) {
    const { article, sourceIndex } = selected;
    try {
      const image = buildImagePlan(article, { bodyCount: 0 }).images[0];
      const response = await fetch(`${baseUrl}/api/hub/image/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-api-key': hubKey },
        body: JSON.stringify({
          role: 'thumbnail',
          providerMode: 'kie',
          aspectRatio: '16:9',
          prompt: image.prompt
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || !data.imageBase64) {
        const failure = {
          index: sourceIndex,
          title: article.title,
          generated: false,
          http: response.status,
          error: String(data.error || 'REQUEST_FAILED'),
          providerCode: Number.isInteger(data.providerCode) ? data.providerCode : null,
          qaAttempts: Number(data.qaAttempts || 0),
          qaViolationCount: Number(data.qaViolationCount || 0),
          qaDetectedTextCount: Number(data.qaDetectedTextCount || 0)
        };
        results.push(failure);
        console.log(`KIE_SCENE_QA index=${sourceIndex}; generated=false; http=${response.status}; error=${failure.error}; providerCode=${failure.providerCode ?? 'none'}; qaAttempts=${failure.qaAttempts}`);
        rejected += 1;
        continue;
      }

      const mime = String(data.mimeType || '').split(';')[0].toLowerCase();
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const file = path.join(outDir, `scene-${sourceIndex}.${ext}`);
      fs.writeFileSync(file, Buffer.from(String(data.imageBase64), 'base64'));
      const ocr = detectText(file);
      if (ocr.rejected) rejected += 1;
      const qaResult = {
        index: sourceIndex,
        title: article.title,
        generated: true,
        provider: String(data.provider || 'none'),
        mime,
        internalImageQa: data.imageQa || null,
        ocrAlnum: ocr.alnumCount,
        textFree: !ocr.rejected,
        ocrText: ocr.text,
        highConfidenceWords: ocr.highConfidenceWords,
        meaningfulWords: ocr.meaningfulWords
      };
      results.push(qaResult);
      console.log(`KIE_SCENE_QA index=${sourceIndex}; generated=true; provider=${qaResult.provider}; mime=${mime}; internalQa=${JSON.stringify(qaResult.internalImageQa)}; ocrAlnum=${ocr.alnumCount}; meaningfulOcr=${ocr.meaningfulWords.length}; textFree=${!ocr.rejected}; ocrText=${JSON.stringify(ocr.text)}`);
    } catch (error) {
      rejected += 1;
      const failure = {
        index: sourceIndex,
        title: article.title,
        generated: false,
        error: String(error?.message || 'SCENE_QA_ITEM_FAILED')
      };
      results.push(failure);
      console.log(`KIE_SCENE_QA index=${sourceIndex}; generated=false; error=${failure.error}`);
    }
  }

  healthAfter = await health('after');
  afterGateConfirmed = true;
} catch (error) {
  fatalError = String(error?.message || 'SCENE_QA_FATAL');
  rejected = Math.max(rejected, 1);
  console.log(`KIE_SCENE_QA_FATAL error=${fatalError}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  total: probeArticles.length,
  requestedLimit: qaLimit,
  requestedIndex: qaStartIndex + 1,
  rejected,
  bloggerWrites: beforeGateConfirmed && afterGateConfirmed ? 'OFF_CONFIRMED_BEFORE_AFTER' : 'NOT_FULLY_CONFIRMED',
  beforeGateConfirmed,
  afterGateConfirmed,
  healthBefore,
  healthAfter,
  fatalError,
  results
};
fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`KIE_SCENE_QA_COMPLETE total=${probeArticles.length}; rejected=${rejected}; beforeGate=${beforeGateConfirmed}; afterGate=${afterGateConfirmed}; imageQaConfigured=${Boolean(healthAfter?.imageQaConfigured || healthBefore?.imageQaConfigured)}`);
if (fatalError || rejected > 0 || !beforeGateConfirmed || !afterGateConfirmed) process.exitCode = 2;
