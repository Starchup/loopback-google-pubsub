module.exports = function startPubsub(app)
{
    // Server
    var pubsubServer = require('../../pubsub.js')(app,
    {
        type: 'server',
        serviceName: 'test-server',
        projectId: process.env.GCLOUD_PROJECT,
        modelsToBroadcast: ['Customer']
    });

    // Client
    var pubsubClient = require('../../pubsub.js')(app,
    {
        type: 'client',
        serviceName: 'test-client',
        projectId: process.env.GCLOUD_PROJECT,
        modelsToSubscribe: ['Customer'],
        eventFn: function (modelName, methodName, modelId, data)
        {
            app.models.Order.create(
            {
                customerId: modelId
            });
        }
    });

};