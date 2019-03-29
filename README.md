# serverless-connect-voicemail

A [Serverless Framework](https://github.com/serverless/serverless) project containing lamba's used to enable of voicemail functionality using Amazon Connect call recoding functionality.  

For more information on how this works with Amazon Connect, see the companion blog post for this project:  
[Creating a voicemail system with Amazon Connect Part 2](https://kzn.io/blog/2018/07/03/serverless-voicemail-with-amazon-connect-2/)  

## Development

Install the [Serverless Framework](https://serverless.com/framework/docs/getting-started/).

Install project dependencies:  
```
$ npm install
```

Customise the values in the custom.param section of serverless.yml.  
Some changes to resource names in the resources section will probably also be needed.  


## Deployment

### Parameter Store

The voicemail agent's login credentials  need to be set manually in parameter store first:  
```
/serverless-voicemail/agentLogin/ccpUsername
/serverless-voicemail/agentLogin/ccpPassword
```

### Serverless deployment

Deploying using the serverless framework CLI:  
```
$ AWS_PROFILE=YOUR_PROFILE_NAME serverless deploy -v --aws-s3-accelerate
```

