// Free, keyless "search" capability. There is no free full-web-results API
// (Google/Bing require paid keys), so this uses two free, keyless sources:
//   1. DuckDuckGo's Instant Answer API — good for facts, definitions,
//      disambiguation, and topical summaries.
//   2. Wikipedia's public search + summary API — good general-knowledge
//      fallback when DuckDuckGo has no instant answer.
// This is not a general web-results engine; it's closer to "quick facts."

export async function duckDuckGoAnswer(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo request failed: HTTP ${res.status}`);
  const data = await res.json();

  const text = data.AbstractText || data.Answer || null;
  if (!text) return null;

  return {
    text,
    source: data.AbstractSource || "DuckDuckGo",
    url: data.AbstractURL || null
  };
}

export async function wikipediaSummary(query) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`Wikipedia search failed: HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();
  const hit = searchData?.query?.search?.[0];
  if (!hit) return null;

  const title = hit.title;
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) return null;
  const summary = await summaryRes.json();

  return {
    text: summary.extract,
    source: `Wikipedia — ${title}`,
    url: summary.content_urls?.desktop?.page || null
  };
}

// Tries DuckDuckGo first (usually more current/topical), falls back to
// Wikipedia (usually more encyclopedic coverage).
export async function quickSearch(query) {
  const ddg = await duckDuckGoAnswer(query).catch(() => null);
  if (ddg) return ddg;

  const wiki = await wikipediaSummary(query).catch(() => null);
  if (wiki) return wiki;

  return null;
}

export function formatSearchResult(query, result) {
  if (!result) {
    return `No quick answer found for "${query}". This search covers DuckDuckGo's instant answers and Wikipedia summaries — not general web results — so obscure or very current queries may come back empty.`;
  }
  const lines = [result.text];
  if (result.url) lines.push(`\n${result.source}: ${result.url}`);
  else lines.push(`\nSource: ${result.source}`);
  return lines.join("\n");
}
