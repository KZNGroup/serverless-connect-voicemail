const {DateTime} = require('luxon');

const agent = require('./agent');
const cwl = require('./aws/cwl');
const s3 = require('./aws/s3');
const sns = require('./aws/sns');
const transcribe = require('./aws/transcribe');

const CONNECT_LOG_GROUP = process.env.CONNECT_LOG_GROUP;
const NOTIFICATION_TOPIC = process.env.NOTIFICATION_TOPIC;
const NOTIFICATION_TIMEZONE = process.env.NOTIFICATION_TIMEZONE;
const LINK_EXPIRY_IN_DAYS = parseInt(process.env.LINK_EXPIRY_IN_DAYS, 10);
const LINK_EXPIRY_IN_SECONDS = LINK_EXPIRY_IN_DAYS * 86400;
const TRANSCRIBE_WAIT_SECONDS = 240;
const VOICEMAIL_PROCESSED_EVENT = 'VOICEMAIL_PROCESSED';
const SEARCH_PERIOD_IN_DAYS = 1;

/**
 * Process voicemail recordings.
 *
 * @param {Object} event - The event that triggered our lambda,
 *                         containing S3 Object details.
 * @return {Object} result - Indicator of successful run
 */
exports.process = async (event) => {
  // Agent would have just gotten off a call, so make it Available again
  // Errors are ignored so we still attempt the processing of the voicemail.
  try {
    agent.sendLoginEvent({
      event: VOICEMAIL_PROCESSED_EVENT,
    });
  } catch (err) {
    console.log(err);
  }

  // Process the voicemail message
  try {
    let voicemail = getS3ObjectInfo(event.Records[0]);
    voicemail.contactId = contactIdFromObjectKey(voicemail.objectKey);
    voicemail = await addCallAttributes(voicemail);

    if (!voicemail.voicemail) {
      console.log('non-voicemail call, ignoring');
      return {success: true};
    }

    voicemail.transcript = await transcribeRecording(voicemail);
    voicemail.preSignedUrl = await getPresignedS3Url(voicemail);

    await sendNotification(voicemail);

    return {success: true};
  } catch (err) {
    console.error(err);
    await sns.publish({
      topicArn: NOTIFICATION_TOPIC,
      subject: 'Voicemail processing failure',
      message: `Voicemail processing encountered an error:
        ${err}`,
    });
    throw err;
  }
};

/**
 * Returns attributes found in contact flow logs for a call.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @param {Object} voicemail.contactId - The ID of the call in Amazon Connect.
 * @return {Object} - Voicemail details with additional attributes added
 */
async function addCallAttributes(voicemail) {
  const {events} = await getContactFlowLogs(voicemail.contactId);

  return {
    ...voicemail,
    ...parseCallAttributes(events),
  };
}

/**
 * Searches cloudwatch logs for events related to an Amazon Connect call.
 *
 * @param {String} contactId - ID of the call to find logs for
 * @return {Array} - Contact flow log events related to the call
 */
async function getContactFlowLogs(contactId) {
  const params = {
    logGroupName: CONNECT_LOG_GROUP,
    filterPattern: `{
      ($.ContactId = "${contactId}") &&
        ($.ContactFlowModuleType = "SetAttributes")
    }`,
    startTime: DateTime.local().minus({days: SEARCH_PERIOD_IN_DAYS}).toMillis(),
  };
  return await cwl.filterLogEvents(params);
}

/**
 * Returns call attributes found in the given contact flow logs.
 *
 * @param {Array} events - Contact flow log events to find attributes in.
 * @return {Object} attrs - The attributes found for the call.
 * @return {Object} attrs.callingNumber - Caller ID, if set by call flow.
 * @return {Object} attrs.purpose - Purpose the call, if set by call flow.
 * @return {Object} attrs.voicemail - Whether the call should be processed as a
 *                                    voicemail message.
 */
function parseCallAttributes(events) {
  let attributes = {};
  console.log('parsing call attributes...');
  if (typeof events !== undefined && events.length > 0) {
    for (let event of events) {
      const message = JSON.parse(event.message);
      const {Key, Value} = message.Parameters;
      attributes[Key] = formatAttribute(Key, Value);
    }
  }
  return attributes;
}


/**
 * Converts the call recording audio into a text transcript.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @param {string} voicemail.objectUrl - S3 URL of the recording audio file.
 * @return {string} - The transcript of the call recording.
 */
async function transcribeRecording({objectUrl}) {
  const job = await transcribe.startJob({mediaFileUri: objectUrl});

  // Wait for the transcribe job to complete, it takes at least 60 seconds.
  // This could be improved by using step functions or SQS in future.
  const transcript = await transcribe.awaitJob({
    jobName: job.TranscriptionJobName,
    waitSeconds: TRANSCRIBE_WAIT_SECONDS,
  });
  return transcript;
}

/**
 * Get a pre-signed (pre-authenticated) URL for a file in S3,
 * to allow us to give a download link in notification emails without
 * requiring the recipient to already be logged in to the correct
 * AWS account console.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @param {string} voicemail.bucketName - S3 bucket name
 * @param {string} voicemail.objectKey - S3 object key to generate url for.
 * @return {string} - Pre-signed URL to the file.
 */
async function getPresignedS3Url({bucketName, objectKey}) {
  const params = {
    operation: 'getObject',
    expirySeconds: LINK_EXPIRY_IN_SECONDS,
    bucketName,
    objectKey,
  };
  return await s3.getSignedUrl(params);
}

/**
 * Send SNS notification containing details of the voicemail message
 * and a link to download the original recording.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @return {Object} - Published SNS message details.
 */
async function sendNotification(voicemail) {
  console.log('sending voicemail notification...');

  return await sns.publish({
    topicArn: NOTIFICATION_TOPIC,
    subject: notificationSubject(voicemail),
    message: notificationMessage(voicemail),
  });
}

/**
 * Re-format a call attribute key-value pair if necessary.
 *
 * @param {string} key - Key name of attribute.
 * @param {*} value - Value of attribute, which might be reformatted.
 * @return {*} - Value of attribute after performing any reformatting.
 */
function formatAttribute(key, value) {
  if (key === 'callingNumber') {
    return formatPhoneNumber(value);
  }
  return value;
}

/**
 * Convert phone numbers from E.164 to a more human readable format.
 *
 * @param {string} phoneNumber - Phone number, possibly in E.164 format.
 * @return {string} - Reformatted phone number.
 *
 * @example
 * formatPhoneNumber('+61412345678') => '0412 345 678'
 * @example
 * formatPhoneNumber('+61812341234') => '08 1234 1234'
 */
function formatPhoneNumber(phoneNumber) {
  let formattedNumber = phoneNumber;

  // Replace +61 with 0
  let match = phoneNumber.match(/\+61(\d+)/);
  if (match) {
    formattedNumber = `0${match[1]}`;
  }

  // split mobile number
  match = formattedNumber.match(/^(04\d{2})(\d{3})(\d{3})$/);
  if (!match) {
    // split national number
    match = formattedNumber.match(/^(\d{2})(\d{4})(\d{4})$/);
  }
  if (match) {
    formattedNumber = `${match[1]} ${match[2]} ${match[3]}`;
  }

  return formattedNumber;
}

/**
 * Format a luxon DateTime object in a human readable format.
 *
 * @param {Object} dateTime - The DateTime object to format.
 * @return {string} - Human readable date.
 *
 * @example
 * 'Tue Jun 19, 3:03 PM GMT+8'
 */
function formatDate(dateTime) {
  return dateTime
    .setZone(NOTIFICATION_TIMEZONE)
    .toFormat('ccc LLL d, h:mm a ZZZZ');
}

/**
 * Parse a call ID from an S3 Object key generated by Amazon Connect.
 *
 * @param {string} objectKey - S3 Object key name to parse.
 * @return {string} - contactId of the call in Amazon Connect.
 *
 * @example
 * 'some/path/49ff0244-82f5-4c51-83b4-c2b0d7374f3a_20180619T07:02_UTC.wav'
 *   => '49ff0244-82f5-4c51-83b4-c2b0d7374f3a'
 */
function contactIdFromObjectKey(objectKey) {
  console.log('Object Key: ' + objectKey);
  let [, contactId] = /.*\/([a-zA-Z0-9-]+)_.*/.exec(objectKey) || [];
  if (contactId != null) {
    console.log('parsed contactId from objectKey: ' + contactId);
  } else {
    throw new TypeError('Unexpected objectKey format');
  }
  return contactId;
}

/**
 * Get information about the S3 object from the given lambda event.Record[0]
 * that triggered us.
 *
 * @param {Object} eventRecord - Record object from the lambda event.
 * @return {Object} - Details of the new S3 object that triggered us.
 */
function getS3ObjectInfo(eventRecord) {
  const bucketName = eventRecord.s3.bucket.name;
  const creationDate = eventRecord.eventTime;
  const urlEncodedObjectKey = eventRecord.s3.object.key.replace(/\+/g, ' ');
  const objectKey = decodeURIComponent(urlEncodedObjectKey);

  return {
    bucketName,
    creationDate,
    objectKey: objectKey,
    objectUrl: `https://${bucketName}.s3.amazonaws.com/${objectKey}`,
    consoleUrl: `https://s3.console.aws.amazon.com/s3/object/${bucketName}/${objectKey}`,
  };
}

/**
 * Build the subject to be used in new voicemail notification messages.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @param {string} voicemail.purpose - The purpose of the call.
 * @param {string} voicemail.callingNumber - The caller's phone number.
 * @return {string} - A formatted subject suitable for email notifications.
 */
function notificationSubject({purpose, callingNumber}) {
  let purposeString = '';
  if (purpose) {
    purposeString = ` ${purpose}`;
  }
  return `[${purposeString}] Voice-mail from ${callingNumber}`;
}

/**
 * Build the message body to be used in new voicemail notification messages.
 *
 * @param {Object} voicemail - Details of the voicemail call being processed.
 * @param {string} voicemail.purpose - The purpose of the call.
 * @param {string} voicemail.callingNumber - The caller's phone number.
 * @param {string} voicemail.creationDate - The date the voicemail was left.
 * @param {string} voicemail.transcript - A text transcript of the call.
 * @param {string} voicemail.preSignedUrl - A link to download the recording.
 * @param {string} voicemail.consoleUrl - A link to download the recording.
 * @return {string} - A formatted message suitable for email notifications.
 */
function notificationMessage(voicemail) {
  const creationDate = formatDate(DateTime.fromISO(voicemail.creationDate));
  const expiryDate = formatDate(DateTime.local().plus({
    days: LINK_EXPIRY_IN_DAYS,
  }));

  return `
Caller: ${voicemail.callingNumber}
Called at: ${creationDate}
Purpose: ${voicemail.purpose}

Transcript:
===========
${voicemail.transcript}
===========

Download (valid until ${expiryDate}): ${voicemail.preSignedUrl}

-

Download (requires log-in): ${voicemail.consoleUrl}

================================================================================
`;
}

// JSDOC TYPE DEFINITIONS:

/**
 * @param {Error} an error if one occured, otherwise null.
 * @param {Object} response object.
 */

