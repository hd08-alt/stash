// Keyword-based categoriser. Each keyword is matched as a word prefix, so
// "poet" also matches "poetry" and "poets". A trailing "!" means whole word
// only ("art!" matches "art" and "arts" but not "article"). Edit freely.
export const CATEGORIES = {
  'Philosophy': ['philosoph', 'stoic', 'ethic', 'moral', 'existential', 'metaphysic', 'nietzsche', 'seneca', 'kant', 'spinoza', 'wittgenstein', 'consciousness', 'meaning of life', 'virtue', 'epistem', 'socrat', 'plato', 'aristotle', 'buddhis', 'zen!'],
  'Science': ['scien', 'physic', 'biolog', 'chemist', 'astronom', 'cosmos', 'universe', 'quantum', 'evolution', 'darwin', 'einstein', 'galileo', 'experiment', 'genetic', 'neuron', 'molecul', 'mathemat', 'telescope', 'planet', 'star!', 'galax'],
  'Mind & Psychology': ['psycholog', 'mind!', 'brain', 'emotion', 'anxiety', 'depress', 'grief', 'memory', 'attention', 'habit', 'cognit', 'therapy', 'mental health', 'self-', 'loneliness', 'happiness', 'motivation', 'decision', 'bias', 'neuroscien'],
  'Art & Design': ['art!', 'artist', 'paint', 'illustrat', 'drawing', 'design', 'museum', 'gallery', 'sculpt', 'photograph', 'architect', 'typograph', 'woodcut', 'watercolor', 'watercolour', 'print!', 'exhibit', 'visual!'],
  'Books & Writing': ['book', 'novel', 'poem', 'poet', 'poetry', 'literat', 'writer', 'writing', 'author', 'essay', 'librar', 'reading', 'fiction', 'memoir', 'tolkien', 'woolf', 'rilke', 'mary oliver', 'whitman', 'dickinson', 'baldwin'],
  'Creativity': ['creativ', 'creative', 'inspiration', 'craft!', 'make things', 'notebook', 'diary', 'journal', 'process!', 'imagination', 'invent', 'curiosity', 'studio', 'practice!'],
  'Nature': ['nature', 'tree!', 'forest', 'bird!', 'flower', 'animal', 'ocean', 'sea!', 'river', 'mountain', 'climate', 'ecolog', 'wild!', 'garden', 'botan', 'season', 'whale', 'insect', 'moth', 'butterfl'],
  'History': ['history', 'historic', 'ancient', 'century', 'medieval', 'victorian', 'renaissance', 'war!', 'empire', 'archive', 'antiquit', 'revolution', '1800s', '1900s', 'civiliz', 'civilis'],
  'Society & Culture': ['society', 'culture', 'politic', 'democra', 'justice', 'economic', 'race!', 'gender', 'feminis', 'religio', 'community', 'citizen', 'language', 'education', 'work!', 'money!', 'capitalis'],
  'Music & Film': ['music', 'song!', 'compos', 'symphon', 'jazz', 'piano', 'film!', 'cinema', 'movie', 'documentar', 'animation', 'beatles', 'bach!', 'opera'],
  'Technology': ['technolog', 'internet', 'computer', 'software', 'artificial intelligence', 'ai!', 'algorithm', 'digital', 'robot', 'machine learning', 'smartphone', 'social media'],
  'Living Well': ['love!', 'friendship', 'kindness', 'solitude', 'courage', 'hope!', 'joy!', 'wonder', 'death!', 'mortality', 'aging', 'ageing', 'parenting', 'relationship', 'wellbeing', 'well-being', 'meaning', 'purpose'],
};

export const FALLBACK_CATEGORY = 'Miscellany';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MATCHERS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([cat, words]) => [
    cat,
    words.map((w) => {
      const whole = w.endsWith('!');
      const word = escape(whole ? w.slice(0, -1) : w);
      return new RegExp(`(?:^|[^a-z])${word}${whole ? 's?(?![a-z])' : ''}`, 'gi');
    }),
  ]),
);

function count(re, s) {
  re.lastIndex = 0;
  return (s.match(re) || []).length;
}

/**
 * Score an article against every category.
 * Title and the publisher's own tags are weighted heavily; body text lightly
 * (and logarithmically, so a single long essay can't swamp everything).
 * @returns {{ category: string, tags: string[] }}
 */
export function categorize({ title = '', tags = [], text = '' }) {
  const t = title.toLowerCase();
  const g = tags.join(' | ').toLowerCase();
  const b = text.toLowerCase().split(/\s+/).slice(0, 2500).join(' ');

  const scores = Object.entries(MATCHERS).map(([cat, res]) => {
    let score = 0;
    for (const re of res) {
      score += count(re, t) * 4 + count(re, g) * 3 + Math.log2(1 + count(re, b));
    }
    return [cat, score];
  });

  scores.sort((a, b) => b[1] - a[1]);
  const [best] = scores;
  if (!best || best[1] < 2) return { category: FALLBACK_CATEGORY, tags: [] };

  const related = scores
    .slice(1)
    .filter(([, s]) => s >= Math.max(3, best[1] * 0.6))
    .slice(0, 2)
    .map(([c]) => c);

  return { category: best[0], tags: related };
}
