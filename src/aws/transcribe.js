const AWS = require('aws-sdk');
const Transcribe = new AWS.TranscribeService({
    apiVersion: '2017-10-26',
    region: process.env.AWS_REGION,
});
const axios = require('axios');
const {DateTime} = require('luxon');

const INITIAL_WAIT_MS = 60000;
const TRANSCRIBE_PENDING = 'IN_PROGRESS';
const TRANSCRIBE_COMPLETED = 'COMPLETED';
const TRANSCRIBE_FAILED = 'FAILED';

/**
 * Start an AWS Transcribe job for a given audio file.
 *
 * @param {Object} params - Parameters to use.
 * @params {string} params.mediaFileUri - Uri of media file in S3.
 * @params {string} params.mediaFormat - Type of audio file.
 * @return {Object} - Job details, including name needed to query status.
 */
exports.startJob = async ({mediaFileUri, mediaFormat}) => {
  const {filename, extension} = _getFileParts(mediaFileUri);
  if (!mediaFormat) {
    mediaFormat = extension || 'wav';
  }
  const timestamp = DateTime.local().toMillis();
  const params = {
    LanguageCode: 'en-US',
    Media: {
      MediaFileUri: mediaFileUri,
    },
    MediaFormat: mediaFormat,
    TranscriptionJobName: _normalisedJobName(`${filename}_${timestamp}`),
  };
  console.log('Start job: ' + JSON.stringify(params));
  const result = await Transcribe.startTranscriptionJob(params).promise();
  const {TranscriptionJob: job} = result;
  console.log('Start job result:');
  console.log(job);
  return job;
};

/**
 * Wait for a transcribe job to complete, up to a certain number of seconds.
 *
 * @param {Object} params - Parameters to use.
 * @params {string} params.jobName - Identifier of transcribe job.
 * @params {string} params.waitSeconds - How long to wait before giving up.
 * @return {string} - The transcribed text of the audio file.
 */
exports.awaitJob = async ({jobName, waitSeconds}) => {
  console.log('waiting for transcription job to complete...');
  console.log(`jobName: ${jobName}`);
  await _wait(INITIAL_WAIT_MS);

  let job = null;
  let triesLeft = 6;
  const waitBetweenRetries = (waitSeconds * 1000 - INITIAL_WAIT_MS) / triesLeft;
  while (triesLeft > 0) {
    triesLeft--;
    const params = {
      TranscriptionJobName: jobName,
    };
    const result = await Transcribe.getTranscriptionJob(params).promise();
    job = result.TranscriptionJob;
    console.log('getTranscriptionJob job:');
    console.log(job);

    if (TRANSCRIBE_PENDING !== job.TranscriptionJobStatus) {
      break;
    }
    await _wait(waitBetweenRetries);
  }

  console.log('After waiting for job to finish, job details:');
  console.log(job);

  if (TRANSCRIBE_COMPLETED === job.TranscriptionJobStatus) {
    const transcriptUrl = job.Transcript.TranscriptFileUri;
    const response = await axios.get(transcriptUrl);
    console.log('Transcription result:');
    console.log(JSON.stringify(response.data));
    const transcripts = response.data.results.transcripts;
    if (typeof transcripts !== undefined && transcripts.length > 0) {
      console.log('Transcript: ' + transcripts[0].transcript);
      return transcripts[0].transcript;
    }
  } else if (TRANSCRIBE_FAILED === job.TranscriptionJobStatus) {
    throw new Error('Transcription failure: ' + job.FailureReason);
  }
};

/**
 * Split a full path to a file into a path, name and extension.
 *
 * @param {string} fileUri - The file path to be split.
 * @return {Object} result - The parsed file segments.
 * @return {string} result.path - The path of the files parent directory.
 * @return {string} result.filename - The name of the file, without extension.
 * @return {string} result.extension - The extension of the file, without a dot.
 *
 * @example
 * 'some/path/to/file.thing'
 *   => {path: 'some/path/to/', filename: 'file', extension: 'thing'}
 */
function _getFileParts(fileUri) {
  let path = null;
  let filename = null;
  let extension = null;
  const match = fileUri.match(/(.*[\\\/])?(.+?)\.([^.]*$|$)/);
  if (match) {
    [, path, filename, extension] = match;
  }
  return {path, extension, filename};
}

/**
 * Replace characters not allowed in Transcribe job names.
 *
 * @param {string} jobName - The string to be normalised to a valid job name.
 * @return {string} result - Normalised string appropriate for a job name.
 */
function _normalisedJobName(jobName) {
  return jobName.replace(/[^0-9a-zA-Z._-]/g, '_');
}

/**
 * Return a Promise that resolves after the given amount of time.
 *
 * @param {integer} ms - How long to wait before resolving in milliseconds.
 * @return {Promise} - Promise that will resolve after the given amount of time.
 */
function _wait(ms) {
  console.log(`waiting ${ms}ms...`);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
