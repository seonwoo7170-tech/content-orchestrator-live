function stripImageFigures(html) {
  return String(html || '')
    .replace(/<figure\b[^>]*>[\s\S]*?<img\b[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, '');
}

export function stripWriterOwnedImages(article) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const html = String(article.html || '');
  if (!html) return article;
  const stripped = stripImageFigures(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (stripped === html) return article;
  return { ...article, html: stripped };
}
