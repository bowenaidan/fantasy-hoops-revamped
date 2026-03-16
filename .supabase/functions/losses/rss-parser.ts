import Parser from 'rss-parser';

const parser = new Parser();
// TODO: read this in from a config file
const DEFAULT_URL = 'https://rss.app/feeds/dQisPFzPzNx46CFd.xml';

/**
 * Parse the RSS feed at the given URL.
 * @param url URL of the RSS feed
 */
export async function parseRss(url: string) {
  const feed = await parser.parseURL(url);
  const returnArray: string[][] = [];

  feed.items.forEach((item: any) => {
    returnArray.push([item.title, item.link, item.pubDate]);
  });

  return { title: feed.title, items: returnArray };
}

if (require.main === module) {
  (async () => {
    try {
      const url = process.argv[2] || DEFAULT_URL;
      const result = await parseRss(url);
      console.log(`Feed Title: ${result.title}`);
      result.items.forEach(([title, link, pubDate]) => {
        console.log(`Item Title: ${title}`);
        console.log(`Item Link: ${link}`);
        console.log(`Item Upload Date: ${pubDate}`);
      });
    } catch (error) {
      console.error('Error fetching or parsing the RSS feed:', error);
    }
  })();
}