import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseFeed } from '../scripts/lib/parse-feed.mjs';
import { categorize } from '../scripts/lib/categorize.mjs';
import { cleanHtml } from '../scripts/lib/extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(path.join(here, 'fixtures', name), 'utf8');

test('parses RSS 2.0 with full content', async () => {
  const items = parseFeed((await fixture('sample-rss.xml')).replaceAll('{{BASE}}', 'http://x'));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Rilke on Living the Questions');
  assert.equal(items[0].author, 'Maria Popova');
  assert.deepEqual(items[0].categories, ['Books', 'poetry']);
  assert.match(items[0].content, /young poet/);
  assert.equal(items[0].published, '2026-10-02T08:00:00.000Z');
  assert.equal(items[1].title, 'The Hidden Life of Trees & Forests');
});

test('parses Atom', async () => {
  const [e] = parseFeed((await fixture('sample-atom.xml')).replaceAll('{{BASE}}', 'http://x'));
  assert.equal(e.link, 'http://x/physics');
  assert.equal(e.author, 'A. Physicist');
  assert.deepEqual(e.categories, ['Physics']);
});

test('categorises by subject', () => {
  assert.equal(categorize({ title: 'Rilke on poetry and the patience of writing', tags: ['Books'] }).category, 'Books & Writing');
  assert.equal(categorize({ title: 'How the quantum universe began', tags: ['physics'] }).category, 'Science');
  assert.equal(categorize({ title: 'A walk among old trees', text: 'forest birds river' }).category, 'Nature');
  assert.equal(categorize({ title: 'An article about artificial things' }).category, 'Miscellany');
});

test('sanitises HTML and absolutises URLs', () => {
  const out = cleanHtml('<p onclick="x()">Hi <a href="/a">link</a></p><script>bad()</script><img src="i.png"><iframe src="e"></iframe>', 'https://site.test/post/');
  assert.doesNotMatch(out, /script|onclick|iframe/);
  assert.match(out, /href="https:\/\/site.test\/a" target="_blank" rel="noopener noreferrer"/);
  assert.match(out, /src="https:\/\/site.test\/post\/i.png"/);
});

test('fetch-feeds builds the index end to end', async () => {
  const server = createServer(async (req, res) => {
    const files = { '/rss': 'sample-rss.xml', '/atom': 'sample-atom.xml', '/physics': 'physics.html', '/trees': 'trees.html' };
    const name = files[req.url];
    if (!name) return res.writeHead(404).end();
    res.end((await fixture(name)).replaceAll('{{BASE}}', base));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = await mkdtemp(path.join(tmpdir(), 'stash-'));
  const feedsFile = path.join(dir, 'feeds.json');
  await writeFile(feedsFile, JSON.stringify({
    settings: { keepDays: 100000, maxPerFeed: 10, fetchFullText: true },
    feeds: [
      { name: 'Sample RSS', url: `${base}/rss` },
      { name: 'Sample Atom', url: `${base}/atom` },
      { name: 'Broken', url: `${base}/missing` },
    ],
  }));
  const env = { ...process.env, FEEDS_FILE: feedsFile, DATA_DIR: path.join(dir, 'data') };
  const run = () => promisify(execFile)(process.execPath, [path.join(here, '..', 'scripts', 'fetch-feeds.mjs')], { env });

  try {
    await run();
    const index = JSON.parse(await readFile(path.join(dir, 'data', 'index.json'), 'utf8'));
    assert.equal(index.articles.length, 3);
    assert.deepEqual(index.feeds.map((f) => f.ok), [true, true, false]);

    const rilke = index.articles.find((a) => a.title.startsWith('Rilke'));
    assert.equal(rilke.category, 'Books & Writing');
    assert.equal(rilke.fullText, true);
    assert.equal(rilke.image, `${base}/img/rilke.jpg`);
    const body = JSON.parse(await readFile(path.join(dir, 'data', 'articles', `${rilke.id}.json`), 'utf8'));
    assert.doesNotMatch(body.html, /<script|onclick|iframe/);

    // Teaser-only feed entry: full text pulled from the page with Readability.
    const physics = index.articles.find((a) => a.title.includes('quantum'));
    assert.equal(physics.fullText, true);
    assert.equal(physics.category, 'Science');
    assert.equal(physics.image, `${base}/og.jpg`);
    const pbody = JSON.parse(await readFile(path.join(dir, 'data', 'articles', `${physics.id}.json`), 'utf8'));
    assert.doesNotMatch(pbody.html, /Subscribe now|Copyright/);

    // Page too thin to beat the feed summary: keep the summary, flag it.
    const trees = index.articles.find((a) => a.title.includes('Trees'));
    assert.equal(trees.fullText, false);
    assert.equal(trees.category, 'Nature');

    // Second run adds nothing new.
    await run();
    const again = JSON.parse(await readFile(path.join(dir, 'data', 'index.json'), 'utf8'));
    assert.equal(again.articles.length, 3);
    assert.equal(again.feeds[0].added, 0);
  } finally {
    server.close();
  }
});
