const agent = require('../agent');
const config = require('./config');
const puppeteer = require('puppeteer');

(async (a, b, c) => {
    const browser = await puppeteer.launch({
        headless: false,
        slowMo: process.env.SLOWMO_MS,
        dumpio: !!config.DEBUG,
    });
    await agent.run(browser)
    .then((result) => console.log(result))
    .catch((err) => console.error(err));
    await browser.close();
})();
