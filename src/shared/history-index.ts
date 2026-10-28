import { normalizeText, type HistoryEntry, type HistoryHit } from './history';

interface Posting {
  title: number;
  body: number;
}

const BODY_TOKEN_LIMIT = 4000;
const SNIPPET_RADIUS = 90;

/**
 * Splits text into lowercase word tokens. Unicode-aware so Cyrillic, accented
 * Latin and other scripts work without a language-specific stemmer.
 */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 || /\d/.test(token));
}

function snippetFor(entry: HistoryEntry, query: string, tokens: string[]): string {
  const text = normalizeText(entry.text);
  if (!text) return '';
  const lower = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  let at = needle ? lower.indexOf(needle) : -1;
  if (at === -1) {
    for (const token of tokens) {
      at = lower.indexOf(token);
      if (at !== -1) break;
    }
  }
  if (at === -1) return text.slice(0, 180) + (text.length > 180 ? '…' : '');
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * In-memory inverted index with a BM25-flavoured score.
 *
 * The corpus is chat history: tens of thousands of documents at most, rebuilt
 * from JSONL on startup. A hand-written index keeps the app dependency-free and
 * avoids a native SQLite module in the packaged builds.
 */
export class HistoryIndex {
  private docs = new Map<string, HistoryEntry>();
  private postings = new Map<string, Map<string, Posting>>();
  private tokensByDoc = new Map<string, string[]>();

  get size(): number {
    return this.docs.size;
  }

  add(entry: HistoryEntry): void {
    this.remove(entry.id);

    const titleTokens = tokenize(entry.title);
    const bodyTokens = tokenize(entry.text).slice(0, BODY_TOKEN_LIMIT);
    const all = new Set([...titleTokens, ...bodyTokens]);
    this.tokensByDoc.set(entry.id, [...all]);

    const titleCounts = new Map<string, number>();
    for (const token of titleTokens) titleCounts.set(token, (titleCounts.get(token) ?? 0) + 1);
    const bodyCounts = new Map<string, number>();
    for (const token of bodyTokens) bodyCounts.set(token, (bodyCounts.get(token) ?? 0) + 1);

    for (const token of all) {
      let map = this.postings.get(token);
      if (!map) {
        map = new Map();
        this.postings.set(token, map);
      }
      map.set(entry.id, { title: titleCounts.get(token) ?? 0, body: bodyCounts.get(token) ?? 0 });
    }

    this.docs.set(entry.id, entry);
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return;
    for (const token of this.tokensByDoc.get(id) ?? []) {
      const map = this.postings.get(token);
      if (!map) continue;
      map.delete(id);
      if (map.size === 0) this.postings.delete(token);
    }
    this.tokensByDoc.delete(id);
    this.docs.delete(id);
  }

  get(id: string): HistoryEntry | undefined {
    return this.docs.get(id);
  }

  all(): HistoryEntry[] {
    return [...this.docs.values()];
  }

  search(query: string, limit = 30): HistoryHit[] {
    const search = query.trim();
    if (search.length < 2) return [];

    const tokens = [...new Set(tokenize(search))].slice(0, 8);
    const total = this.docs.size;
    const scores = new Map<string, number>();
    const matched = new Map<string, number>();

    if (tokens.length > 0) {
      for (const token of tokens) {
        const map = this.postings.get(token);
        if (!map) continue;
        const idf = Math.log(1 + (total - map.size + 0.5) / (map.size + 0.5));
        for (const [id, posting] of map) {
          const tf = posting.title * 4 + Math.min(posting.body, 8);
          scores.set(id, (scores.get(id) ?? 0) + idf * (1 + tf));
          matched.set(id, (matched.get(id) ?? 0) + 1);
        }
      }
    }

    // Prefer documents that match every token; fall back to any-token matches
    // so a typo or an extra word does not hide a good result.
    let candidates = [...scores.keys()].filter((id) => (matched.get(id) ?? 0) === tokens.length);
    if (candidates.length === 0) candidates = [...scores.keys()];

    // Substring pass: covers phrases split across tokens, CJK text and cases
    // where the tokenizer disagrees with the user's spacing.
    const needle = search.toLowerCase();
    if (needle.length >= 2) {
      for (const entry of this.docs.values()) {
        const inTitle = entry.title.toLowerCase().includes(needle);
        const inBody = !inTitle && entry.text.toLowerCase().includes(needle);
        if (!inTitle && !inBody) continue;
        if (!scores.has(entry.id)) candidates.push(entry.id);
        scores.set(entry.id, (scores.get(entry.id) ?? 0) + (inTitle ? 8 : 4));
      }
    }

    const hits: HistoryHit[] = [];
    for (const id of new Set(candidates)) {
      const entry = this.docs.get(id);
      if (!entry) continue;
      hits.push({
        id,
        tabId: entry.tabId,
        service: entry.service,
        url: entry.url,
        title: entry.title,
        snippet: snippetFor(entry, search, tokens),
        score: Number((scores.get(id) ?? 0).toFixed(3)),
        titleOnly: entry.titleOnly,
        capturedAt: entry.capturedAt
      });
    }

    hits.sort((a, b) => b.score - a.score || b.capturedAt - a.capturedAt);
    return hits.slice(0, limit);
  }
}
