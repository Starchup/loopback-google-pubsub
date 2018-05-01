# loopback-google-pubsub
Pubsub system for Loopback using Google Pubsub

### Usage client side

In a boot script
```
// Instanciate with the app and tell it what model name to listen to
var pubsubClient = require('loopback-google-pubsub')(app,
{
    type: 'client',
    serviceName: CLIENT_NAME,
    projectId: GOOGLE_CLOUD_PROJECT_ID,
    modelsToSubscribe: ['Order'],
    eventFn: function(modelName, methodName, modelId, data, cb) {...}
});
```


Then in the models you want to use pubsub
```
// Require the pubsub with options.serviceName
var pubsubClient = require('loopback-google-pubsub')(app, {serviceName: CLIENT_NAME});
```


### Usage server side

In a boot script
```

// Instanciate with the app
var pubsubServer = require('loopback-google-pubsub')(app,
{
    type: 'server',
    serviceName: SERVER_NAME,
    projectId: GOOGLE_CLOUD_PROJECT_ID,
    modelsToBroadcast: ['Order'],
    //Optional list of functions taking (modelName, methodName, instance, ctx) as arguments. If any return false, message will not be published
    filters: [filterFunction1, filterFunction2]
});
```

### Notes
* `process.env.NODE_ENV` is required, as it is used to differentiate topic and subscription names by environment on Google PubSub.
