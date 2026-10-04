# Stash

A read-it-later app for long-form reading. Every morning Stash collects new
articles from your RSS feeds (The Marginalian, Aeon, Psyche and others),
pulls out the article text, sorts each piece into a subject, and publishes
everything as a small website you can open on your phone or computer.

- **Today**: the morning's new articles, grouped by subject.
- **Browse**: the last 45 days of articles, filtered by subject or search.
- **Reading list**: articles you've saved. They're kept on your device, so
  they stay readable offline and after they drop out of the 45-day window.
  You can also save any other link.
- **Reader view**: clean text with no ads, three page colours (auto, sepia,
  night), serif or sans, and adjustable size. It remembers how far you got.
- **Read aloud**: listen to any article using your device's voices. The
  paragraph being read is highlighted, and you can skip, change speed or
  pick a voice. Lock-screen controls work where the browser supports them.
- **Install it**: Stash is a web app you can add to your home screen.
- **Free hosting**: GitHub Actions fetches the feeds and GitHub Pages hosts the
  site. You need no server, database or paid account.

## Put it online (about 5 minutes, free)

The repository must be **public** for free GitHub Pages hosting.

1. **Merge this work into `main`.** The daily schedule only runs from the
   default branch.
2. **Turn on Pages.** In the repo, go to **Settings → Pages**. Under
   *Build and deployment → Source*, choose **GitHub Actions**.
3. **Run it once now.** Open the **Actions** tab, pick **Fetch articles and
   publish**, and click **Run workflow**. It takes a minute or two.
4. Open **https://hd08-alt.github.io/stash/**. After this it updates by
   itself every day at 06:17 UTC.

To install it on a phone, open the site and use **Share → Add to Home Screen**
(iOS) or **⋮ → Install app** (Android/Chrome).

## Choose your feeds

Edit [`feeds.json`](feeds.json) on GitHub and commit. The next run picks up
the change.

```json
{ "name": "The Marginalian", "url": "https://www.themarginalian.org/feed/", "site": "https://www.themarginalian.org" }
```

| Setting          | Default | Meaning                                                    |
| ---------------- | ------- | ---------------------------------------------------------- |
| `keepDays`       | 45      | How long articles stay in Today/Browse.                    |
| `maxPerFeed`     | 15      | How many recent entries to check per feed each day.        |
| `fetchFullText`  | true    | If a feed only gives a teaser, fetch the page and extract the article. |

Some sites only publish summaries and block automated page fetches. Those
articles show the summary and a link to the original. The Settings panel
shows which feeds worked on the last run.

To change the time of the daily run, edit the `cron` line in
[`.github/workflows/update.yml`](.github/workflows/update.yml). The time is in UTC.

## Categories

Stash sorts articles with keyword rules in
[`scripts/lib/categorize.mjs`](scripts/lib/categorize.mjs). It weighs the
title most, then the publisher's own tags, then the article text. To add a
subject or tune one, edit its word list.

## Reading list sync (optional)

Your reading list is stored in the browser you save from. To share it between
your phone and laptop, open **Settings** in the app and paste a GitHub token
that has **only** the `gist` permission
([create one here](https://github.com/settings/tokens/new?scopes=gist&description=Stash%20reading%20list)).
Stash keeps the list in one private gist and merges changes from every device.
The token is stored only in that browser's local storage. Use a token with
just the gist permission, and revoke it on GitHub if a device is lost.

Without sync, use **Settings → Download backup** and **Restore backup** to
move your list by hand.

## Run it on your computer

```sh
npm install
npm run fetch   # fetch feeds into public/data
npm run serve   # open http://localhost:8080
npm test
```

## How it fits together

```
feeds.json ──► scripts/fetch-feeds.mjs ──► public/data/index.json
               (daily, GitHub Actions)     public/data/articles/<id>.json
                                                     │
                       public/  (static site, GitHub Pages)
                       index.html · app.js · styles.css · sw.js
```

- `scripts/fetch-feeds.mjs` reads RSS and Atom feeds. When a feed has only a
  teaser, it runs Mozilla Readability (the engine behind Firefox Reader View)
  on the page. It cleans the HTML with DOMPurify, categorises the article and
  writes static JSON. Articles older than `keepDays` are removed.
- The workflow commits the new data, so the repo keeps a history, and then
  deploys `public/` to Pages.
- The web app has no build step. Read aloud uses the browser's built-in
  Web Speech API. Offline reading uses a service worker and Cache Storage.
