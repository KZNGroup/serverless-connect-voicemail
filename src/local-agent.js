const agent = require('./agent');
const puppeteer = require('puppeteer');

(async () => {
  // Just used to test locally. Note it uses the full version of
  // puppeteer, and will launch a GUI chrome that it has downloaded
  // instead of a headless one
  const browser = await puppeteer.launch({
      headless: false,
      slowMo: process.env.SLOWMO_MS,
      dumpio: !!process.env.DEBUG,
  });
  await agent.run(browser)
  .then((result) => console.log(result))
  .catch((err) => console.error(err));
  await browser.close();
})();
