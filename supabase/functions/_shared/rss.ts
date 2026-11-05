// RSS feed reader for detecting buy-game losses.
// TODO: parse the Jon Rothstein feed for "epitome of brutality" posts and insert them
// into point_adjustments (kind = 'buy_game_loss', source_url = item link for dedupe).

import Parser from "npm:rss-parser@3";

export const DEFAULT_FEED_URL = "https://rss.app/feeds/dQisPFzPzNx46CFd.xml";

export type FeedItem = { title: string; link: string; pubDate: string };

export async function parseRss(url: string = DEFAULT_FEED_URL): Promise<{ title?: string; items: FeedItem[] }> {
  const feed = await new Parser().parseURL(url);
  return {
    title: feed.title,
    items: feed.items.map((item) => ({
      title: item.title ?? "",
      link: item.link ?? "",
      pubDate: item.pubDate ?? "",
    })),
  };
}
