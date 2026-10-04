#!/usr/bin/env node
// Pulls every feed in feeds.json, extracts readable article text, sorts each
// article into a category and writes static JSON for the web app:
//
//   public/data/index.json            – list of all current articles (no bodies)
//   public/data/articles/<id>.json    – one file per article with its HTML body
//
// Run daily by .github/workflows/update.yml; run locally with `npm run fetch`.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFeed } from './lib/parse-feed.mjs';
import { categorize, CATEGORIES, FALLBACK_CATEGORY } from './lib/categorize.mjs';
import { cleanHtml, excerpt, firstImageIn, htmlToText, readable } from './lib/extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS_FILE = process.env.FEEDS_FILE || path.join(ROOT, 'feeds.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'public', 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const USER_AGENT = 'Mozilla/5.0 (compatible; StashReader/1.0; +https://github.com/)';
const FULL_TEXT_MIN_WORDS = 250; // feed bodies shorter than this are treated as teasers
const WORDS_PER_MINUTE = 230;
const DAY = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (text) => (text ? text.split(/\s+/).length : 0);
const absolute = (u, base) => { try { return u ? new URL(u, base).href : null; } catch { return null; } };
const articleId = (key) => createHash('sha1').update(key).digest('hex').slice(0, 12);

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Work out the best body we can get for a feed entry. */
async function buildBody(entry, { fetchFullText }) {
  const feedHtml = entry.content || entry.summary || '';
  const feedText = htmlToText(feedHtml);

  if (wordCount(feedText) >= FULL_TEXT_MIN_WORDS) {
    return { html: feedHtml, fullText: true };
  }

  if (fetchFullText && entry.link) {
    try {
      const page = await get(entry.link, 'text/html,application/xhtml+xml');
      const art = readable(page, entry.link);
      if (art && wordCount(htmlToText(art.html)) > wordCount(feedText)) {
        return { html: art.html, image: art.image, byline: art.byline, fullText: true };
      }
    } catch (err) {
      console.warn(`    ! couldn't fetch full text (${err.message}); using feed summary`);
    }
  }
  return { html: feedHtml, fullText: false };
}

async function processFeed(feed, known, settings) {
  const xml = await get(feed.url, 'application/rss+xml, application/atom+xml, application/xml, text/xml');
  const entries = parseFeed(xml)
    .filter((e) => e.title && e.link)
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, settings.maxPerFeed);

  const added = [];
  for (const entry of entries) {
    const id = articleId(entry.guid || entry.link);
    if (known.has(id)) continue;

    console.log(`  + ${entry.title}`);
    const body = await buildBody(entry, settings);
    const html = cleanHtml(body.html, entry.link);
    const text = htmlToText(html);
    const words = wordCount(text);
    const { category, tags } = categorize({ title: entry.title, tags: entry.categories, text });

    await writeFile(path.join(ARTICLES_DIR, `${id}.json`), JSON.stringify({ id, html }));
    added.push({
      id,
      title: entry.title,
      link: entry.link,
      feed: feed.name,
      author: entry.author || body.byline || '',
      published: entry.published || new Date().toISOString(),
      fetched: new Date().toISOString(),
      category,
      tags,
      excerpt: excerpt(htmlToText(entry.summary) || text),
      image: absolute(entry.image || body.image, entry.link) || firstImageIn(html),
      words,
      minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
      fullText: body.fullText,
    });
    await sleep(400); // be polite to the sites we're reading
  }
  return added;
}

async function main() {
  const config = JSON.parse(await readFile(FEEDS_FILE, 'utf8'));
  const settings = { keepDays: 45, maxPerFeed: 15, fetchFullText: true, ...config.settings };
  await mkdir(ARTICLES_DIR, { recursive: true });

  const previous = await readJson(INDEX_FILE, { articles: [] });
  const known = new Set(previous.articles.map((a) => a.id));
  let articles = [...previous.articles];
  const feedStatus = [];

  for (const feed of config.feeds) {
    console.log(`• ${feed.name}`);
    try {
      const added = await processFeed(feed, known, settings);
      added.forEach((a) => known.add(a.id));
      articles.push(...added);
      feedStatus.push({ name: feed.name, site: feed.site || null, ok: true, added: added.length });
    } catch (err) {
      console.error(`  ✗ ${feed.name}: ${err.message}`);
      feedStatus.push({ name: feed.name, site: feed.site || null, ok: false, error: err.message, added: 0 });
    }
  }

  // Forget articles older than keepDays and delete their body files.
  const cutoff = Date.now() - settings.keepDays * DAY;
  articles = articles
    .filter((a) => new Date(a.fetched).getTime() >= cutoff)
    .sort((a, b) => b.published.localeCompare(a.published));
  const keep = new Set(articles.map((a) => `${a.id}.json`));
  for (const file of await readdir(ARTICLES_DIR)) {
    if (file.endsWith('.json') && !keep.has(file)) await rm(path.join(ARTICLES_DIR, file));
  }

  const index = {
    generatedAt: new Date().toISOString(),
    categories: [...Object.keys(CATEGORIES), FALLBACK_CATEGORY],
    feeds: feedStatus,
    articles,
  };
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 1));

  const newCount = feedStatus.reduce((n, f) => n + f.added, 0);
  console.log(`\nDone: ${newCount} new, ${articles.length} total, ${feedStatus.filter((f) => !f.ok).length} feed(s) failed.`);
  if (feedStatus.length && feedStatus.every((f) => !f.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
