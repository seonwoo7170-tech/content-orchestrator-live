const VERSION = 'natural-writing-lint-v2';

const STRONG_CLICHES = Object.freeze({
  ko: [
    { re: /현대 사회에서/g, label: '현대 사회에서' },
    { re: /빠르게 변화하는 시대(?:에|에서)?/g, label: '빠르게 변화하는 시대' },
    { re: /오늘날의 디지털 시대(?:에|에서)?/g, label: '오늘날의 디지털 시대' },
    { re: /중요성이 (?:더욱 )?커지고 있습니다/g, label: '중요성이 커지고 있습니다' },
    { re: /(?:함께 )?살펴보겠습니다/g, label: '살펴보겠습니다' },
    { re: /(?:함께 )?알아보겠습니다/g, label: '알아보겠습니다' },
    { re: /도움이 되셨기를 바랍니다/g, label: '도움이 되셨기를 바랍니다' },
    { re: /지금까지 .{0,80}(?:에 대해|를|을) 알아보았습니다/g, label: '지금까지 ~ 알아보았습니다' }
  ],
  en: [
    { re: /in today['’]s fast[- ]paced world/gi, label: "in today's fast-paced world" },
    { re: /in today['’]s digital age/gi, label: "in today's digital age" },
    { re: /in the ever[- ]evolving landscape/gi, label: 'in the ever-evolving landscape' },
    { re: /it is important to note that/gi, label: 'it is important to note that' },
    { re: /let['’]s (?:dive in|explore)/gi, label: "let's dive in / explore" },
    { re: /we hope (?:this|the) (?:guide|article).{0,60}(?:helpful|useful)/gi, label: 'we hope this guide was helpful' },
    { re: /whether you['’]re a beginner or (?:an expert|a seasoned professional)/gi, label: "whether you're a beginner or an expert" }
  ]
});

const GENERIC_CONCLUSIONS = Object.freeze({
  ko: [
    /결론적으로[,. ]/g,
    /이제 여러분도 .{0,80}(?:할 수 있습니다|실천할 수 있습니다)/g,
    /위 내용을 참고하면 .{0,80}(?:도움이 될 수 있습니다|활용할 수 있습니다)/g
  ],
  en: [
    /\bin conclusion[, ]/gi,
    /by following these tips,? you can/gi,
    /with the right approach,? you can/gi
  ]
});

const CONNECTORS = Object.freeze({
  ko: ['또한', '특히', '따라서', '그러나', '한편', '결론적으로'],
  en: ['additionally', 'moreover', 'furthermore', 'therefore', 'however', 'in conclusion']
});

const ENDING_PATTERNS = Object.freeze({
  ko: [
    { re: /할 수 있습니다[.!?]?$/, label: '~할 수 있습니다' },
    { re: /하는 것이 중요합니다[.!?]?$/, label: '~하는 것이 중요합니다' },
    { re: /필요합니다[.!?]?$/, label: '~필요합니다' },
    { re: /도움이 됩니다[.!?]?$/, label: '~도움이 됩니다' },
    { re: /권장됩니다[.!?]?$/, label: '~권장됩니다' }
  ],
  en: [
    { re: /\bcan help[.!?]?$/i, label: 'can help' },
    { re: /\bis important[.!?]?$/i, label: 'is important' },
    { re: /\bis essential[.!?]?$/i, label: 'is essential' },
    { re: /\bcan be useful[.!?]?$/i, label: 'can be useful' }
  ]
});

const LOW_INFORMATION = Object.freeze({
  ko: [
    /^(?:상황에 맞는|적절한|올바른) (?:선택|관리|방법|대응)이 중요합니다[.!?]?$/,
    /^(?:각자의|자신의) 상황에 맞게 (?:적용|선택|활용)하는 것이 중요합니다[.!?]?$/,
    /^필요에 따라 적절히 활용하는 것이 좋습니다[.!?]?$/
  ],
  en: [
    /^choosing the right (?:approach|method) is important[.!?]?$/i,
    /^proper management is important[.!?]?$/i,
    /^it is important to choose the right (?:approach|method)[.!?]?$/i
  ]
});

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function textOnly(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBlocks(html) {
  const source = String(html || '');
  const blocks = [];
  const re = /<(p|h2|h3|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let index = 0;
  while ((match = re.exec(source))) {
    const text = textOnly(match[2]);
    if (!text) continue;
    index += 1;
    const tag = match[1].toLowerCase();
    blocks.push({ tag, location: `html ${tag} ${index}`, text });
  }
  if (blocks.length === 0) {
    const text = textOnly(source);
    if (text) blocks.push({ tag: 'body', location: 'html body', text });
  }
  return blocks;
}

function splitSentences(blocks) {
  const sentences = [];
  for (const block of blocks) {
    const parts = block.text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const text of parts) sentences.push({ tag: block.tag, location: block.location, text });
  }
  return sentences;
}

function normalizeSentence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”‘’"']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(value, max = 70) {
  const text = String(value || '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function issue(code, severity, location, reason, repairInstruction) {
  return { code, severity, location, reason, repairInstruction };
}

function uniqueLocations(items) {
  return [...new Set(items.map((item) => String(item?.location || '').trim()).filter(Boolean))];
}

function coefficientOfVariation(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!mean) return null;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function countMatches(text, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return [...String(text || '').matchAll(new RegExp(regex.source, flags))].length;
}

function detectCliches(language, blocks, blockingIssues) {
  const rules = STRONG_CLICHES[language] || STRONG_CLICHES.en;
  for (const block of blocks) {
    for (const rule of rules) {
      const count = countMatches(block.text, rule.re);
      if (!count) continue;
      blockingIssues.push(issue(
        'AI_STYLE_CLICHE',
        'MEDIUM',
        block.location,
        `Stock AI-like phrase detected (${count}x): "${rule.label}".`,
        'Rewrite only this sentence or paragraph in plain, topic-specific language. Remove the stock phrase while preserving factual meaning and verified claims.'
      ));
    }
  }
}

function detectGenericConclusion(language, blocks, flags) {
  if (!blocks.length) return;
  const tail = blocks.slice(-2);
  const rules = GENERIC_CONCLUSIONS[language] || GENERIC_CONCLUSIONS.en;
  for (const block of tail) {
    for (const re of rules) {
      if (!re.test(block.text)) continue;
      flags.push(issue(
        'GENERIC_CONCLUSION',
        'LOW',
        block.location,
        `The closing uses a generic summary/encouragement pattern: "${excerpt(block.text)}".`,
        'Keep the ending only if it adds a concrete next action, decision rule, warning, or useful detail; otherwise shorten or remove the generic wrap-up.'
      ));
      re.lastIndex = 0;
    }
  }
}

function isTableOfContentsHeadingEcho(list) {
  if (list.length !== 2) return false;
  const listItem = list.find((item) => item.tag === 'li');
  const heading = list.find((item) => item.tag === 'h2' || item.tag === 'h3');
  return Boolean(listItem && heading);
}

function detectDuplicateSentences(sentences, blockingIssues) {
  const groups = new Map();
  for (const sentence of sentences) {
    const normalized = normalizeSentence(sentence.text);
    if (normalized.length < 16) continue;
    const list = groups.get(normalized) || [];
    list.push(sentence);
    groups.set(normalized, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2 || isTableOfContentsHeadingEcho(list)) continue;
    const duplicateLocations = uniqueLocations(list.slice(1));
    for (const location of duplicateLocations) {
      blockingIssues.push(issue(
        'DUPLICATE_SENTENCE',
        'HIGH',
        location,
        `The same sentence is repeated ${list.length} times: "${excerpt(list[0].text)}".`,
        'Rewrite or remove the duplicate sentence in this exact block while preserving any unique information and keeping the strongest original occurrence elsewhere.'
      ));
    }
  }
}

function detectConnectors(language, sentences, blockingIssues, flags) {
  const connectors = CONNECTORS[language] || CONNECTORS.en;
  const starts = [];
  const matches = new Map();
  for (const sentence of sentences) {
    const lower = sentence.text.toLowerCase();
    const connector = connectors.find((candidate) => {
      const token = candidate.toLowerCase();
      return lower === token || lower.startsWith(`${token} `) || lower.startsWith(`${token},`);
    });
    starts.push(connector || null);
    if (connector) {
      const list = matches.get(connector) || [];
      list.push(sentence);
      matches.set(connector, list);
    }
  }

  for (const [connector, list] of matches) {
    const count = list.length;
    const locations = uniqueLocations(list);
    if (count >= 4) {
      for (const location of locations) {
        blockingIssues.push(issue(
          'REPEATED_CONNECTOR',
          'MEDIUM',
          location,
          `The connector "${connector}" starts ${count} sentences across the article, creating a templated rhythm.`,
          `Rewrite the affected sentence opening(s) in this exact block. Use a direct transition or remove unnecessary "${connector}" while preserving the underlying facts.`
        ));
      }
    } else if (count === 3) {
      for (const location of locations) {
        flags.push(issue(
          'REPEATED_CONNECTOR',
          'LOW',
          location,
          `The connector "${connector}" starts 3 sentences across the article.`,
          'Check whether the connector is necessary in this exact block; vary only the opening if it sounds repetitive.'
        ));
      }
    }
  }

  for (let i = 0; i <= starts.length - 3; i += 1) {
    if (starts[i] && starts[i + 1] && starts[i + 2]) {
      const streak = sentences.slice(i, i + 3);
      for (const location of uniqueLocations(streak)) {
        blockingIssues.push(issue(
          'CONNECTOR_STREAK',
          'MEDIUM',
          location,
          'This block participates in a three-sentence connector streak that produces a formulaic cadence.',
          'Rewrite only the affected sentence opening(s) in this exact block so the transition follows the content naturally.'
        ));
      }
      break;
    }
  }
}

function detectRepeatedEndings(language, sentences, blockingIssues, flags) {
  const patterns = ENDING_PATTERNS[language] || ENDING_PATTERNS.en;
  const matches = new Map();
  for (const sentence of sentences) {
    for (const pattern of patterns) {
      if (pattern.re.test(sentence.text.trim())) {
        const list = matches.get(pattern.label) || [];
        list.push(sentence);
        matches.set(pattern.label, list);
        break;
      }
    }
  }
  for (const [label, list] of matches) {
    const count = list.length;
    const locations = uniqueLocations(list);
    if (count >= 4) {
      for (const location of locations) {
        blockingIssues.push(issue(
          'REPEATED_SENTENCE_ENDING',
          'MEDIUM',
          location,
          `The same sentence ending pattern (${label}) appears ${count} times across the article.`,
          'Rewrite only the affected sentence ending(s) in this exact block with direct, concrete phrasing. Do not change factual meaning or introduce new claims.'
        ));
      }
    } else if (count === 3) {
      for (const location of locations) {
        flags.push(issue(
          'REPEATED_SENTENCE_ENDING',
          'LOW',
          location,
          `The same sentence ending pattern (${label}) appears 3 times across the article.`,
          'Check whether the ending sounds templated in this exact block; vary only where needed.'
        ));
      }
    }
  }
}

function detectLowInformation(language, sentences, flags) {
  const rules = LOW_INFORMATION[language] || LOW_INFORMATION.en;
  for (const sentence of sentences) {
    if (!rules.some((re) => re.test(sentence.text.trim()))) continue;
    flags.push(issue(
      'LOW_INFORMATION_BOILERPLATE',
      'LOW',
      sentence.location,
      `Generic low-information sentence detected: "${excerpt(sentence.text)}".`,
      'Replace it with a concrete decision rule, action, example, or remove it if it adds no new information.'
    ));
  }
}

function detectUniformRhythm(blocks, sentences, flags) {
  if (sentences.length >= 8) {
    const lengths = sentences.map((sentence) => normalizeSentence(sentence.text).replace(/\s/g, '').length).filter((value) => value >= 8);
    const cv = coefficientOfVariation(lengths);
    const mean = lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
    if (lengths.length >= 8 && mean >= 20 && cv !== null && cv < 0.12) {
      flags.push(issue(
        'UNIFORM_SENTENCE_RHYTHM',
        'LOW',
        'article body',
        `Sentence lengths are unusually uniform (coefficient of variation ${cv.toFixed(2)} across ${lengths.length} sentences).`,
        'Review the rhythm. Keep natural variation by shortening only obvious filler sentences or combining closely related ones; do not change facts merely to vary length.'
      ));
    }
  }

  if (blocks.length >= 5) {
    const lengths = blocks.map((block) => normalizeSentence(block.text).replace(/\s/g, '').length).filter((value) => value >= 20);
    const cv = coefficientOfVariation(lengths);
    if (lengths.length >= 5 && cv !== null && cv < 0.10) {
      flags.push(issue(
        'UNIFORM_PARAGRAPH_PATTERN',
        'LOW',
        'article body',
        `Paragraph lengths are unusually uniform (coefficient of variation ${cv.toFixed(2)}).`,
        'Check for template-like paragraph construction. Adjust only paragraphs that repeat the same explanatory pattern; preserve useful structure.'
      ));
    }
  }
}

function detectRepeatedParagraphOpenings(blocks, flags) {
  const groups = new Map();
  for (const block of blocks.filter((item) => item.location.includes(' p '))) {
    const normalized = normalizeSentence(block.text);
    const words = normalized.split(' ').filter(Boolean);
    const key = words.length >= 4 ? words.slice(0, 4).join(' ') : normalized.slice(0, 18);
    if (key.length < 10) continue;
    const list = groups.get(key) || [];
    list.push(block);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    flags.push(issue(
      'REPEATED_PARAGRAPH_OPENING',
      'LOW',
      list.map((item) => item.location).join(', '),
      `Three or more paragraphs begin with the same pattern: "${excerpt(key)}".`,
      'Vary only the repeated paragraph openings where the repetition is stylistic rather than logically necessary.'
    ));
  }
}

function riskScore(blockingIssues, flags) {
  const weights = { LOW: 5, MEDIUM: 15, HIGH: 25, CRITICAL: 35 };
  const total = [...blockingIssues, ...flags].reduce((sum, item) => sum + (weights[item.severity] || 5), 0);
  return Math.min(100, total);
}

export function lintNaturalWriting(article) {
  const language = article?.language === 'ko' ? 'ko' : 'en';
  const blocks = extractBlocks(article?.html);
  const sentences = splitSentences(blocks);
  const blockingIssues = [];
  const flags = [];

  detectCliches(language, blocks, blockingIssues);
  detectDuplicateSentences(sentences, blockingIssues);
  detectConnectors(language, sentences, blockingIssues, flags);
  detectRepeatedEndings(language, sentences, blockingIssues, flags);
  detectGenericConclusion(language, blocks, flags);
  detectLowInformation(language, sentences, flags);
  detectUniformRhythm(blocks, sentences, flags);
  detectRepeatedParagraphOpenings(blocks, flags);

  const status = blockingIssues.length > 0 ? 'BLOCK' : flags.length > 0 ? 'FLAG' : 'PASS';
  return {
    version: VERSION,
    status,
    riskScore: riskScore(blockingIssues, flags),
    blockingIssues,
    flags,
    metrics: {
      language,
      paragraphLikeBlockCount: blocks.length,
      sentenceCount: sentences.length
    }
  };
}
