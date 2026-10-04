import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Returns the text of a node that may be a string, a number, or { '#text': ... }.
function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return text(node['#text'] ?? '');
  return '';
}

function atomLink(links) {
  const all = asArray(links);
  const alt = all.find((l) => !l['@rel'] || l['@rel'] === 'alternate');
  return (alt || all[0])?.['@href'] || text(all[0]);
}

function toISO(value) {
  const d = new Date(text(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function firstImage(item) {
  const media = asArray(item['media:content']).concat(asArray(item['media:thumbnail']));
  const m = media.find((x) => x?.['@url'] && (!x['@medium'] || x['@medium'] === 'image'));
  if (m) return m['@url'];
  const enc = asArray(item.enclosure).find((e) => String(e?.['@type'] || '').startsWith('image/'));
  return enc?.['@url'] || null;
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF) or Atom document into a flat list of entries.
 */
export function parseFeed(xml) {
  const doc = parser.parse(xml);

  if (doc.feed) {
    return asArray(doc.feed.entry).map((e) => ({
      title: text(e.title),
      link: atomLink(e.link),
      guid: text(e.id) || atomLink(e.link),
      published: toISO(e.published || e.updated),
      author: text(asArray(e.author)[0]?.name),
      categories: asArray(e.category).map((c) => c['@term'] || text(c)).filter(Boolean),
      summary: text(e.summary),
      content: text(e.content),
      image: firstImage(e),
    }));
  }

  const channel = doc.rss?.channel || doc['rdf:RDF']?.channel;
  const items = doc.rss ? asArray(channel?.item) : asArray(doc['rdf:RDF']?.item);
  if (!channel && !items.length) throw new Error('Unrecognised feed format');

  return items.map((i) => ({
    title: text(i.title),
    link: text(i.link) || text(i.guid),
    guid: text(i.guid) || text(i.link),
    published: toISO(i.pubDate || i['dc:date']),
    author: text(i['dc:creator'] || i.author),
    categories: asArray(i.category).map(text).filter(Boolean),
    summary: text(i.description),
    content: text(i['content:encoded']),
    image: firstImage(i),
  }));
}
