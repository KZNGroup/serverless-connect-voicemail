const AWS = require('aws-sdk');
const CWL = new AWS.CloudWatchLogs({
  apiVersion: '2014-03-28',
  region: process.env.CONNECT_REGION,
});

/**
 * Find log events in a log group.
 *
 * @param {Object} params - Params to search by.
 * @params {string} params.logGroupName - The log group to search within.
 * @params {string} params.filterPattern - Filter pattern to limit results by.
 * @params {integer} params.startTime - Epoch with milliseconds to search from.
 * @return {Object} - Result from AWS SDK.
 */
exports.filterLogEvents = async ({logGroupName, filterPattern, startTime}) => {
  const params = {
    logGroupName,
    filterPattern,
    startTime,
  };
  console.log('Filtering log events:');
  console.log(params);
  return await CWL.filterLogEvents(params).promise();
};

