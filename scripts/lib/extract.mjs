import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';

const quietConsole = new VirtualConsole();

const { window: purifyWindow } = new JSDOM('');
const DOMPurify = createDOMPurify(purifyWindow);

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'dfn', 'div', 'dl', 'dt',
    'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
    'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'small', 'source', 'span', 'strong', 'sub', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'datetime', 'colspan', 'rowspan', 'media', 'type'],
};

/** Sanitise article HTML and make links/images absolute and safe. */
export function cleanHtml(html, baseUrl) {
  const { window } = new JSDOM(`<body>${DOMPurify.sanitize(html, PURIFY_CONFIG)}</body>`, {
    url: baseUrl,
    virtualConsole: quietConsole,
  });
  const doc = window.document;

  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      a.href = new URL(a.getAttribute('href'), baseUrl).href;
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } catch {
      a.removeAttribute('href');
    }
  }
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) { img.remove(); continue; }
    try { img.src = new URL(src, baseUrl).href; } catch { img.remove(); continue; }
    img.removeAttribute('srcset'); // relative srcsets are a common source of broken images
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }
  for (const s of doc.querySelectorAll('source')) s.remove();
  // Drop empty paragraphs and wrapper noise left behind by sanitising.
  for (const p of doc.querySelectorAll('p, div, span')) {
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  }
  return doc.body.innerHTML.trim();
}

export function htmlToText(html) {
  const { window } = new JSDOM(`<body>${html}</body>`, { virtualConsole: quietConsole });
  return window.document.body.textContent.replace(/\s+/g, ' ').trim();
}

/** Run Mozilla Readability (the engine behind Firefox Reader View) over a page. */
export function readable(pageHtml, url) {
  const dom = new JSDOM(pageHtml, { url, virtualConsole: quietConsole });
  const article = new Readability(dom.window.document, { charThreshold: 500 }).parse();
  if (!article?.content) return null;
  const ogImage = dom.window.document.querySelector('meta[property="og:image"]')?.content || null;
  return { html: article.content, byline: article.byline || '', image: ogImage };
}

export function excerpt(text, max = 260) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…';
}

export function firstImageIn(html) {
  const m = html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1] : null;
}
