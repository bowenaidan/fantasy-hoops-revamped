//TODO: parse jonrothstein twitter rss feed to find 'epitome of brutality'
import Parser from 'rss-parser';

const parser = new Parser();

(async () => {
  try {
    const feed = await parser.parseURL('https://rss.app/feeds/dQisPFzPzNx46CFd.xml');
    console.log(`Feed Title: ${feed.title}`);

    const returnArray: string[][] = [];

    // Iterate over the items in the feed
    feed.items.forEach((item: any) => {
      returnArray.push([item.title, item.link]);
      console.log(`Item Title: ${item.title}`);
      console.log(`Item Link: ${item.link}`);
    });

  } catch (error) {
    console.error('Error fetching or parsing the RSS feed:', error);
  }
})();