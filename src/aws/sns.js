const AWS = require('aws-sdk');
const SNS = new AWS.SNS({
  apiVersion: '2010-03-31',
  region: process.env.AWS_REGION,
});

/**
 * Publish an SNS message to the given topic.
 *
 * @param {Object} params - Parameters to use.
 * @params {string} params.topicArn - Topic to send message to.
 * @params {string} params.message - Body of message to send.
 * @params {string} params.subject - Subject of message to send.
 * @return {Object} - Message details returned from AWS SDK.
 */
exports.publish = async ({topicArn, message, subject}) => {
  if (!message) {
    throw new TypeError('Need a non-empty message');
  }
  const params = {
    TopicArn: topicArn,
    Message: message,
    Subject: subject,
  };
  console.log('Publish SNS:');
  console.log(params);
  let result = await SNS.publish(params).promise();
  console.log('Publish result:');
  console.log(result);
  return result;
};

