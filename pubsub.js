"use strict";

const PubSub = require('@google-cloud/pubsub');

const pubsubList = {};

module.exports = function (app, options)
{
    const name = options.serviceName;

    if (!pubsubList[name])
    {
        pubsubList[name] = Pubsub.call(
        {}, app, options);
    }
    else if (options.type)
    {
        pubsubList[name] = Pubsub.call(pubsubList[name], app, options);
    }
    return pubsubList[name];
}



/**
 * Creates the Pubsub
 * 
 * @param {object} app - Loopback app object.
 * @param {object} options - Configuration options.
 * @param {string} options.serviceName - Name of pubsub, used to access correct pubsub when reading.
 * @param {string} options.type - Pubsub type.  May be server/client. Inclusion triggers init.
 * @param {string} options.projectId - Google Cloud Project Id.  Required for server/client.
 * @param {object[]} [options.modelsToSubscribe] - Models to subscribe to
 * @param {object[]} [options.modelsToBroadcast] - Models to broadcast
 * @param {function[]} [options.filters] - Array of functions taking modelNames, method, instance and ctx. Return false to block publishing on server
 * @param {function} options.eventFn - Function to call when any event is triggered.
 */
function Pubsub(app, options)
{
    const self = this;

    if (options)
    {
        if (!self.pubsub) self.pubsub = PubSub(
        {
            projectId: options.projectId
        });

        if (!options.serviceName) throw new Error('options.serviceName is required');
        if (!self.serviceName) self.serviceName = options.serviceName;

        if (!process.env.NODE_ENV) throw new Error('process.env.NODE_ENV is required');
        if (!self.env) self.env = process.env.NODE_ENV;

        if (options.filters && !self.filters)
        {
            if (getType(options.filters) !== 'Array') throw new Error('options.filters must be an array of functions');
            self.filters = options.filters;
        }

        if (!self.type) self.type = options.type;

        if (options.type === 'client') clientSide(self, options);
        else if (options.type === 'server') serverSide(self, app, options);
        else if (options.type)
        {
            throw new Error('Type "' + options.type + '"" is not valid. Valid options: client/server');
        }
    }

    return self;
}


/* Pubsub Setup */
var sep = '__';

function findOrCreateTopic(pubsub, topicName)
{
    const topic = pubsub.pubsub.topic([pubsub.env, topicName].join(sep));

    //Find or create topic
    return topic.get(
    {
        autoCreate: true
    }).then(topics =>
    {
        //Google return format, always first index in array
        return topics[0];
    });
}

function createSubscription(pubsub, modelName)
{
    return findOrCreateTopic(pubsub, modelName).then(topic =>
    {
        const subscriptionName = [pubsub.env, pubsub.serviceName, modelName].join(sep);
        return topic.createSubscription(subscriptionName).then(subscriptions =>
        {
            const subscription = subscriptions[0];

            const eventHandler = eventMessageHandler.bind(null, modelName, pubsub);
            const errorHandler = errorMessageHandler.bind(null, topic, subscription);

            //Handlers will receive message object as param
            subscription.on('message', eventHandler);
            subscription.on('error', errorHandler);
        });
    });
}


/* Pubsub Handlers */

function eventMessageHandler(modelName, pubsub, message)
{
    message.ack();

    JSON.parse(message.data.toString('utf8')).forEach(d =>
    {
        if (modelName !== d.modelName || !d.modelId) return;
        pubsub.eventFn(d.modelName, d.methodName, d.modelId, d.data);
    });
}

function errorMessageHandler(topic, subscription, err)
{
    console.error('Error for topic ' + topic.name + ' and subscription ' + subscription.name + ': ' + err.message);
}


/* Model Hook helpers */

function shouldPublish(pubsub, modelName, methodName, instance, ctx)
{
    if (!pubsub.filters || !pubsub.filters.length) return true;
    return pubsub.filters.every(fn =>
    {
        //Silently skip improper filters
        if (getType(fn) !== 'Function') return true;
        return fn(modelName, methodName, instance, ctx);
    });
}

function afterSaveHook(pubsub, app)
{
    return function (ctx, next)
    {
        const modelName = getModelName(ctx);
        if (!modelName) return next();

        const method = ctx.isNewInstance ? 'create' : 'update';
        const topicName = modelName;

        if (ctx.instance && ctx.instance.id && shouldPublish(pubsub, modelName, method, ctx.instance, ctx))
        {
            const instance = JSON.parse(JSON.stringify(ctx.instance));
            return pubsub.emit([
            {
                modelName: modelName,
                methodName: method,
                modelId: instance.id,
                data: instance
            }], topicName);
        }

        if (!ctx.where) return next();

        const Model = app.models[modelName];
        if (!Model) return next();

        Model.find(
        {
            where: ctx.where
        }).then(models =>
        {
            if (!models || models.length < 1) return;

            const data = JSON.parse(JSON.stringify(models)).filter(m =>
            {
                return shouldPublish(pubsub, modelName, methodName, m, ctx);
            }).map(m =>
            {
                return {
                    modelName: modelName,
                    methodName: methodName,
                    modelId: m.id,
                    data: m
                }
            });

            if (data && data.length > 0) return pubsub.emit(data, topicName);

        }).catch(console.error).then(next);
    }
}

//Returns a function that watches model deletions and publishes them
function beforeDeleteHook(pubsub, app)
{
    return function (ctx, next)
    {
        const modelName = getModelName(ctx);
        if (!modelName) return next();

        const Model = app.models[modelName];
        const methodName = 'delete';
        const topicName = modelName;

        Model.find(
        {
            where: ctx.where
        }).then(models =>
        {
            if (!models || models.length < 1) return;

            const data = JSON.parse(JSON.stringify(models)).filter(m =>
            {
                return shouldPublish(pubsub, modelName, methodName, m, ctx);
            }).map(m =>
            {
                return {
                    modelName: modelName,
                    methodName: methodName,
                    modelId: m.id,
                    data: m
                }
            });

            return pubsub.emit(data, topicName);
        }).catch(console.error).then(next);
    }
}


/* General helpers */

function getModelName(ctx)
{
    return ctx.Model && ctx.Model.definition && ctx.Model.definition.name;
}

function getType(val)
{
    return Object.prototype.toString.call(val).slice(8, -1);
}



/* Pubsub starters */

function clientSide(pubsub, options)
{
    if (!options.projectId)
    {
        throw new Error('Google Project Id is required for pubsub client');
    }

    if (!options.modelsToSubscribe || options.modelsToSubscribe.length < 1)
    {
        throw new Error('modelsToSubscribe is required for pubsub client');
    }

    if (!options.eventFn)
    {
        throw new Error('eventFn is required for pubsub client');
    }

    pubsub.eventFn = options.eventFn;

    return options.modelsToSubscribe.reduce((prev, modelName) =>
    {
        return prev.then(() =>
        {
            return createSubscription(pubsub, modelName);
        });
    }, Promise.resolve());
}

function serverSide(pubsub, app, options)
{
    if (!app)
    {
        throw new Error('app is required for pubsub server');
    }

    if (!options.projectId)
    {
        throw new Error('Google Project Id is required for pubsub server');
    }

    if (!options.modelsToBroadcast || options.modelsToBroadcast.length < 1)
    {
        throw new Error('modelsToBroadcast is required for pubsub server');
    }

    options.modelsToBroadcast.forEach(m =>
    {
        const Model = app.models[m];
        if (!m || !Model) return;

        Model.observe('after save', afterSaveHook(pubsub, app));
        Model.observe('before delete', beforeDeleteHook(pubsub, app));
    });

    pubsub.emit = function (data, topicName)
    {
        if (!topicName) throw new Error('Publishing message requires topic name');
        return findOrCreateTopic(pubsub, topicName).then(topic =>
        {
            return topic.publisher().publish(Buffer.from(JSON.stringify(data)), function (err, res)
            {
                if (err) console.error(err);
            });
        });
    }
}