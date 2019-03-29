const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const sns = require('./aws/sns');

const NOTIFICATION_TOPIC = process.env.NOTIFICATION_TOPIC;
const AGENT_LOGIN_TOPIC = process.env.AGENT_LOGIN_TOPIC;
const CCP_URL = process.env.CCP_URL;
const CCP_USERNAME = process.env.CCP_USERNAME;
const CCP_PASSWORD = process.env.CCP_PASSWORD;
const CALL_IN_PROGRESS_EVENT = 'CALL_IN_PROGRESS';

/**
 * Trigger another lambda function via SNS, to avoid blocking calling processes
 * like Amazon Connect Call Flows.
 *
 * @param {Object} event - The event that triggered our lambda.
 * @return {Object} result - Indicates successful run
 */
exports.loginAsync = async (event) => {
  // Just send an SNS message to trigger the lambda
  // that does the logging in.
  try {
    const contactId = event.Details.ContactData.ContactId;
    const parameters = event.Details.Parameters;
    exports.sendLoginEvent({
      contactId,
      parameters,
      event: CALL_IN_PROGRESS_EVENT,
    });
    return {success: null, deferred: true};
  } catch (err) {
    console.error(err);
    await sns.publish({
      topicArn: NOTIFICATION_TOPIC,
      subject: 'Voicemail processing failure',
      message: `Failure triggering voicemail agent to be available:
        ${err}`,
    });
    throw err;
  }
};

/**
 * Start a headless chrome browser and use it to log-in to the Amazon Connect
 * Control Portal, to make an agent available for a queue used to take
 * voicemail messages.
 *
 * @param {Object} event - The event that triggered our lambda.
 * @return {void}
 */
exports.login = async (event) => {
  console.log('event:');
  console.log(JSON.stringify(event));
  try {
    // For keeping the browser launched
    console.log('launching browser...');
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
    });
    console.log('running automation...');
    return await exports.run(browser);
  } catch (err) {
    console.error(err);
    await sns.publish({
      topicArn: NOTIFICATION_TOPIC,
      subject: 'Voicemail processing failure',
      message: `Failure making voicemail agent available:
        ${err}`,
    });
    throw err;
  };
};

/**
 * Send an SNS message to a topic that triggers the login lambda.
 *
 * @param {Object} params - Parameters to be pased to the lambda.
 * @return {Object} - Published SNS message details.
 */
exports.sendLoginEvent = async (params) => {
  return await sns.publish({
    topicArn: AGENT_LOGIN_TOPIC,
    message: JSON.stringify(params),
  });
};

/**
 * Perform the actual login steps within the given browser instance.
 *
 * @param {Object} browser - A puppeteer browser instance / controller.
 * @return {void}
 */
exports.run = async (browser) => {
  console.log('opening new page');
  const page = await browser.newPage();
  console.log('opened page');
  const url = CCP_URL;

  try {
    // Try to visit the CCP page
    console.log(`visiting ${url}`);
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    console.log(`Current Url: ${page.url()}`);

    let loggedIn = false;
    if (page.url() === url) {
      // We weren't redirected to a different url, so might
      // already be logged in from a previous lambda invocation
      console.log('checking if already logged in...');
      let status = await getAgentStatus(page);
      if (status != null) {
        loggedIn = true;
      }
    }

    if (!loggedIn) {
      await fillAndSubmitLoginForm(page);
    }

    await makeAgentAvailable(page);
  } catch (err) {
    console.error(err);
    console.error('Unexpected error, dumping html source:');
    console.error('====================================');
    console.error(await page.content());
    console.error('====================================');
    throw new Error('Failed to log agent in: ' + err);
  } finally {
    await page.close();
    await browser.close();
  }

  return;
};

/**
 * Determine the agent's current status, given an instance of
 * a page possibly logged-in to the Amazon Connect CCP portal.
 *
 * @param {Object} page - A puppeteer page instance.
 * @param {Object} options - Options altering the behaviour of the check.
 * @param {boolean} options.waitForElement - True if we should wait for the
 *                    expected element that contains the status to appear,
 *                    otherwise we should try looking within the page as it
 *                    currently is.
 * @return {string} - The status of the agent, if found.
 */
async function getAgentStatus(page, options = {waitForElement: false}) {
  await page.waitForSelector('body', {visible: true});
  let status = null;
  try {
    if (options.waitForElement) {
      console.log('waiting for state element to appear...');
      await page.waitForSelector('.ccpState', {visible: true});
    }
    status = await page.$eval('.ccpState', (el) => {
      return el.textContent;
    });
    if (status != null) {
      // status element exists, but might not be initialised yet
      // wait for action buttons to appear then grab status again
      console.log('waiting for state change button to appear...');
      await page.waitForSelector('button', {visible: true});
      status = await page.$eval('.ccpState', (el) => {
        return el.textContent;
      });
    }
  } catch (err) {
    // Might not be logged in yet
    console.error('Unable to retrieve agent status');
  }
  console.log('Agent status: ' + status);
  return status;
}

/**
 * Log in as an agent, given a page open to the Amazon Connect CCP login page.
 *
 * @param {Object} page - A puppeteer page instance.
 * @return {void}
 */
async function fillAndSubmitLoginForm(page) {
  // Wait for redirects
  console.log('waiting for username input');
  await page.waitForSelector('input[type="username"]', {visible: true});

  if (CCP_USERNAME == null || CCP_PASSWORD == null) {
    throw new TypeError('Missing agent username or password');
  }

  console.log('filling login form...');
  await page.type('input[type="username"]', CCP_USERNAME);
  await page.focus('input[type="password"]');
  await page.keyboard.type(CCP_PASSWORD);
  await page.keyboard.press('Enter');
  console.log('Submitted login form');
}

/**
 * Set an agent's status to available, given a page logged-in to the Amazon
 * Connect CCP portal. If the agent is already available, or currently on a
 * call, no action will be taken.
 *
 * @param {Object} page - A puppeteer page instance.
 * @return {void}
 */
async function makeAgentAvailable(page) {
  console.log('Getting agent status...');
  let agentStatus = await getAgentStatus(page, {waitForElement: true});
  if (agentStatus != null && /available/i.test(agentStatus)) {
    console.log('Agent is already Available, nothing to do here');
  } else if (agentStatus != null && /connected/i.test(agentStatus)) {
    console.log('Agent is taking a call, leaving it alone');
  } else {
    console.log('Setting agent to Available...');
    await page.click('button.setAvailButton');
    await page.waitForSelector('button.setAvailButton', {hidden: true});

    let agentStatus = await getAgentStatus(page);
    if (agentStatus != null && /(available|connected)/i.test(agentStatus)) {
      console.log('Successfully set agent to Available');
    } else {
      throw new Error('Failed to make agent available');
    }
  }
}

// JSDOC TYPE DEFINITIONS:

/**
 * @callback lambdaCallback
 * @param {Error} an error if one occured, otherwise null.
 * @param {Object} response object.
 */
