const AWS = require('aws-sdk');
const S3 = new AWS.S3({
  apiVersion: '2006-03-01',
  signatureVersion: 'v4', // needed for getSignedUrl to work
  region: process.env.AWS_REGION,
});

/**
 * Get a pre-signed url for an S3 object.
 *
 * @param {Object} params - Parameters to use.
 * @params {string} params.operation - Operation type e.g. 'getObject'.
 * @params {string} params.bucketName - Bucket name containing object.
 * @params {string} params.objectKey - Key name of object.
 * @params {integer} params.expirySeconds - Expiry time from now in seconds.
 * @return {string} - Pre-signed URL.
 */
exports.getSignedUrl = ({operation, bucketName, objectKey, expirySeconds}) => {
  const params = {
    Bucket: bucketName,
    Key: objectKey,
    Expires: expirySeconds,
  };
  console.log('getting signed url with params:');
  console.log(params);
  // S3.getSignedUrl doesn't support .promise()
  // so we'll make one ourselves
  return new Promise((resolve, reject) => {
    S3.getSignedUrl(operation, params, (err, url) => {
      if (err) {
        console.error(err);
        reject(err);
      } else {
        resolve(url);
      }
    });
  });
};

