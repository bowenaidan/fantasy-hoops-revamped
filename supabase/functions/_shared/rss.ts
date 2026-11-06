// RSS feed reader, used by sync-buy-games (the feed is a self-hosted RSSHub route).

import Parser from "npm:rss-parser@3";

export type FeedItem = {
  title: string;
  /** Plain-text body; RSSHub can shorten titles, so the post text is read from here too. */
  text: string;
  link: string;
  pubDate: string;
};

export async function fetchFeed(url: string, timeoutMs = 30_000): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { accept: "application/rss+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Feed returned ${res.status}: ${detail}`);
  }
  const feed = await new Parser().parseString(await res.text());
  return feed.items.map((item) => ({
    title: item.title ?? "",
    text: item.contentSnippet ?? "",
    link: item.link ?? item.guid ?? "",
    pubDate: item.isoDate ?? item.pubDate ?? "",
  }));
}
