"use strict";

const PubSub = require('google-pubsub-wrapper');

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
        self.pubsub = PubSub.init(options.projectId);

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

        if (options.type === 'client') clientSide(self, options).then(function ()
        {
            if (options.done) options.done();
        });
        else if (options.type === 'server') serverSide(self, app, options);
        else if (options.type)
        {
            throw new Error('Type "' + options.type + '"" is not valid. Valid options: client/server');
        }
    }

    return self;
}


/* Model Hook helpers */

function shouldPublish(self, modelName, methodName, instance, ctx)
{
    if (!self.filters || !self.filters.length) return true;
    return self.filters.every(fn =>
    {
        //Silently skip improper filters
        if (getType(fn) !== 'Function') return true;
        return fn(modelName, methodName, instance, ctx);
    });
}

function beforeSaveHook(self, app)
{
    return function (ctx, next)
    {
        if (ctx.data) ctx.hookState.updateData = JSON.parse(JSON.stringify(ctx.data));
        else if (ctx.instance) ctx.hookState.updateData = JSON.parse(JSON.stringify(ctx.instance));

        next();
    }
}

function afterSaveHook(self, app)
{
    return function (ctx, next)
    {
        const modelName = getModelName(ctx);
        if (!modelName) return next();

        const methodName = ctx.isNewInstance ? 'create' : 'update';
        const topicName = modelName;
        const updateData = ctx.hookState.updateData;
        const orderBeforeUpdate = ctx.hookState.orderBeforeUpdate;

        const context = app.loopback.getCurrentContext();
        const accessToken = context && context.get('accessToken');
        let userId = null;
        if (accessToken) userId = accessToken.userId;

        if (ctx.instance && ctx.instance.id && shouldPublish(self, modelName, methodName, ctx.instance, ctx))
        {
            const instance = JSON.parse(JSON.stringify(ctx.instance));
            return self.pubsub.emit([
            {
                modelName: modelName,
                methodName: methodName,
                modelId: instance.id,
                data: instance,
                updateData: updateData,
                userId: userId,
                orderBeforeUpdate: orderBeforeUpdate
            }],
            {
                topicName: topicName,
                env: self.env,
                groupName: self.serviceName
            });
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
                return shouldPublish(self, modelName, methodName, m, ctx);
            }).map(m =>
            {
                return {
                    modelName: modelName,
                    methodName: methodName,
                    modelId: m.id,
                    data: m,
                    userId: userId
                }
            });

            if (data && data.length > 0) return self.pubsub.emit(data,
            {
                topicName: topicName,
                env: self.env,
                groupName: self.serviceName
            });

        }).then(function (res)
        {
            next();
        }).catch(next);
    }
}

//Returns a function that watches model deletions and publishes them
function beforeDeleteHook(self, app)
{
    return function (ctx, next)
    {
        const modelName = getModelName(ctx);
        if (!modelName) return next();

        const Model = app.models[modelName];
        const methodName = 'delete';
        const topicName = modelName;

        const context = app.loopback.getCurrentContext();
        const accessToken = context && context.get('accessToken');
        let userId = null;
        if (accessToken) userId = accessToken.userId;

        Model.find(
        {
            where: ctx.where
        }).then(models =>
        {
            if (!models || models.length < 1) return;

            const data = JSON.parse(JSON.stringify(models)).filter(m =>
            {
                return shouldPublish(self, modelName, methodName, m, ctx);
            }).map(m =>
            {
                return {
                    modelName: modelName,
                    methodName: methodName,
                    modelId: m.id,
                    data: m,
                    userId: userId
                }
            });

            return self.pubsub.emit(data,
            {
                topicName: topicName,
                env: self.env,
                groupName: self.serviceName
            });
        }).then(function (res)
        {
            next();
        }).catch(next);
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

function clientSide(self, options)
{
    if (!options.projectId)
    {
        return Promise.reject(new Error('Google Project Id is required for pubsub client'));
    }

    if (!options.modelsToSubscribe || options.modelsToSubscribe.length < 1)
    {
        return Promise.reject(new Error('modelsToSubscribe is required for pubsub client'));
    }

    if (!options.eventFn)
    {
        return Promise.reject(new Error('eventFn is required for pubsub client'));
    }

    return options.modelsToSubscribe.reduce((prev, modelName) =>
    {
        return prev.then(() =>
        {
            return self.pubsub.subscribe(
            {
                topicName: modelName,
                env: self.env,
                groupName: self.serviceName,
                callback: function (d)
                {
                    if (d) options.eventFn(
                        d.modelName,
                        d.methodName,
                        d.modelId,
                        d.data,
                        d.updateData,
                        d.userId,
                        d.orderBeforeUpdate
                    )
                }
            });
        });
    }, Promise.resolve());
}

function serverSide(self, app, options)
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

        Model.observe('before save', beforeSaveHook(self, app));
        Model.observe('after save', afterSaveHook(self, app));
        Model.observe('before delete', beforeDeleteHook(self, app));
    });
}