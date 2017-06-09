const amqp = require('amqplib/callback_api');
const async = require('async');
const EventEmitter = require('events');
const Pool = require('iampool');
const isString = require('lodash.isstring');
const once = require('lodash.once');
const AmqpStreamPublisher = require('./AmqpStreamPublisher');
const AmqpStreamSubscriber = require('./AmqpStreamSubscriber');
const AmqpStreamTransformer = require('./AmqpStreamTransformer');

const {
    AmqpError,
    AmqpConnectionError,
} = require('./errors');

function noopThrowIfError(err) {
    if (err) throw err;
}

function leaseChannel(pool, handler, cb) {
    pool.acquire((er1, channel) => {
        if (er1) cb(er1);
        handler(channel, (er2, ...res) => {
            if (er2) {
                pool.destroy(channel, cb);
            } else {
                pool.release(channel, cb);
            }
            cb(er2, ...res);
        });
    });
}

/**
 * @param {string} [url]
 *      URL of the form `amqp[s]://[user:password@]hostname[:port][/vhost]`
 * @param {Object} [options]
 * @param {string} [options.url]
 *      URL of the form `amqp[s]://[user:password@]hostname[:port][/vhost]`
 * @param {number} [options.retryTimes = 5]
 *      The number of attempts to make before giving up.
 * @param {Object} [options.poolMaxChannels = 16]
 *      Maximum number of pooled channel
 * @param {Object} [options.poolMaxConfirmChannels = 16]
 *      Maximum number of pooled confirm channel
 * @param {Object} [options.configuration]
 * @param {Array<Object>} [options.configuration.exchanges]
 * @param {Array<Object>} [options.configuration.queues]
 * @param {Array<Object>} [options.configuration.bindings]
 */
class AmqpClient extends EventEmitter {
    constructor(url, options = {}) {
        super();

        if (typeof url === 'object') {
            options = url;
            url = '';
        }

        this._options = {
            url: url || options.url || 'amqp://localhost',
            retryTimes: options.retryTimes || 5,
            poolMaxChannels: options.poolMaxChannels || 16,
            poolMaxConfirmChannels: options.poolMaxConfirmChannels || 16,
        };

        this._connection = null;

        this._ending = false;

        this._channel = new Pool({
            acquire: (cb) => {
                if (this._connection) {
                    this._connection.createChannel(cb);
                } else {
                    this.once('ready', () => {
                        this._connection.createChannel(cb);
                    });
                }
            },
            dispose: (channel, cb) => {
                channel.close(cb);
            },
            min: 0,
            max: options.poolMaxChannels || 10,
            maxWaitingClients: 50,
            acquireTimeoutMs: 10000,
        });

        this._confirmChannel = new Pool({
            acquire: (cb) => {
                if (this._connection) {
                    this._connection.createConfirmChannel(cb);
                } else {
                    this.once('ready', () => {
                        this._connection.createConfirmChannel(cb);
                    });
                }
            },
            dispose: (channel, cb) => {
                channel.close(cb);
            },
            min: 0,
            max: options.poolMaxChannels || 10,
            maxWaitingClients: 50,
            acquireTimeoutMs: 10000,
        });

        this.on('ready', () => {
            this._connection.on('error', (err) => {
                this._connection = null;
                this.emit('error', new AmqpConnectionError(err.message, err));
            });
            this._connection.once('close', () => {
                this.emit('close');
            });
        });

        this._connect();

        this._subscribers = new Set();
        this._publishers = new Set();
    }

    /**
     * publisher(queue, options)
     * publisher(exchange, routingKey, options)
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish
     *      amqp.node — Channel#publish}
     *
     * @param {string} [exchange]
     * @param {string} [routingKey]
     * @param {Object} [options]
     *      Options fields are divided into those that have some meaning to RabbitMQ and those that
     *      will be ignored by RabbitMQ but passed on to consumers. Options may be omitted altogether,
     *      in which case defaults as noted will apply.
     *
     * @param {string} [options.confirmation = false]
     *      If true, the confirm channel will be acquired from the pool
     *
     * Used by RabbitMQ and sent on to consumers:
     *
     * @param {number} [options.expiration]
     *      If supplied, the message will be discarded from a queue once it's been there longer
     *      than the given number of milliseconds.
     * @param {number} [options.expirationMs]
     *      Alias for expiration
     * @param {string} [options.userId]
     *      If supplied, RabbitMQ will compare it to the username supplied when opening the connection,
     *      and reject messages for which it does not match.
     * @param {string|Array<string>} [options.CC]
     *      Messages will be routed to these routing keys in addition to that given as the routingKey parameter.
     *      A string will be implicitly treated as an array containing just that string.
     *      This will override any value given for CC in the headers parameter.
     * @param {string|Array<string>} [options.BCC]
     *      Like CC, except that the value will not be sent in the message headers to consumers.
     * @param {number} [options.priority]
     *      A priority for the message; ignored by versions of RabbitMQ older than 3.5.0,
     *      or if the queue is not a priority queue.
     * @param {boolean} [options.persistent = false]
     *       If truthy, the message will survive broker restarts provided it's in a queue that also survives restarts.
     * @param {boolean} [options.mandatory = false]
     *      If true, the message will be returned if it is not routed to a queue
     *      (i.e., if there are no bindings that match its routing key).
     *
     *
     * Not used by RabbitMQ and not sent to consumers:
     *
     * @param {boolean} [options.immediate]
     *      In the specification, this instructs the server to return the message if it is not able to be sent
     *      immediately to a consumer. No longer implemented in RabbitMQ, and if true, will provoke a channel error,
     *      so it's best to leave it out.
     * @param {string} [options.contentType]
     *      A MIME type for the message content.
     * @param {string} [options.contentEncoding]
     *      A MIME encoding for the message content.
     * @param {Object} [options.headers]
     *      Application specific headers to be carried along with the message content.
     *      The value as sent may be augmented by extension-specific fields if they are given in the parameters,
     *      for example, 'CC', since these are encoded as message headers; the supplied value won't be mutated.
     * @param {string} [options.correlationId]
     *      Usually used to match replies to requests, or similar.
     * @param {AmqpStreamSubscriber|string} [options.replyTo]
     *      Often used to name a queue to which the receiving application must send replies,
     *      in an RPC scenario (many libraries assume this pattern).
     * @param {string} [options.messageId]
     *      Arbitrary application-specific identifier for the message.
     * @param {number} [options.timestamp]
     *      A timestamp for the message.
     * @param {string} [options.type]
     *      An arbitrary application-specific type for the message.
     * @param {string} [options.appId]
     *      An arbitrary identifier for the originating application.
     *
     * @returns {stream.Writable}
     *
     * @example
     *
     *      // without options and callback
     *      publish('foo', 'bar', 'message')
     *      // without options
     *      publish('foo', 'bar', 'message', (err) => {})
     *      // without callback
     *      publish('foo', 'bar', 'message', {expirationMs: 15})
     *      // with options and callback
     *      publish('foo', 'bar', 'message', {expirationMs: 15}, (err) => {})
     *
     */
    publisher(exchange, routingKey, options) {
        if (!isString(exchange)) {
            options = exchange;
            routingKey = '';
            exchange = '';
        }
        if (!isString(routingKey)) {
            options = routingKey;
            routingKey = exchange;
            exchange = '';
        }
        const stream = new AmqpStreamPublisher(this._channel, exchange, routingKey, options);
        this._publishers.add(stream);
        stream.once('finish', () => {
            this._publishers.delete(stream);
        });
        return stream;
    }

    /**
     * subscriber(queue, options)
     *      Readable, stream subscribe on messages from queue
     * subscriber(exchange, routingKey, options)
     *      Readable, create exclusive queue and bind it to the exchange
     *      If incoming message has replyTo property
     *
     * NB RabbitMQ v3.3.0 changes the meaning of prefetch (basic.qos) to apply per-consumer, rather than per-channel.
     * It will apply to consumers started after the method is called.
     * See {@link http://www.rabbitmq.com/consumer-prefetch.html rabbitmq-prefetch}.
     *
     * Use the `global` flag to get the per-channel behaviour. To keep life interesting, using the `global` flag
     * with an RabbitMQ older than v3.3.0 will bring down the whole connection.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume
     *      amqp.node — Channel#consume}
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_prefetch
     *      amqp.node — Channel#prefetch}
     * @see {@link http://www.rabbitmq.com/consumer-prefetch.html rabbitmq.com — Consumer Prefetch}
     *
     * @param {string} [exchange]
     * @param {string} routingKey
     * @param {Object} [options]
     * @param {string} [options.consumerTag]
     * @param {boolean} [options.noLocal = false]
     * @param {boolean} [options.noAck = false]
     * @param {boolean} [options.exclusive = false]
     * @param {number} [options.priority]
     * @param {object} [options.arguments]
     * @param {string} [options.prefetch]
     *      Set the prefetch `count` for this channel. The `count` given is the maximum number of messages
     *      sent over the channel that can be awaiting acknowledgement; once there are `count` messages outstanding,
     *      the server will not send more messages on this channel until one or more have been acknowledged.
     *      A falsey value for `count` indicates no such limit.
     * @param {string} [options.global=false]
     *      Use the `global` flag to get the per-channel prefetch behaviour. To keep life interesting,
     *      using the `global` flag with an RabbitMQ older than v3.3.0 will bring down the whole connection.
     * @returns {stream.Readable}
     */
    subscriber(exchange, routingKey, options) {
        if (!isString(exchange)) {
            options = exchange;
            routingKey = '';
            exchange = '';
        }
        if (!isString(routingKey) && !Array.isArray(routingKey)) {
            options = routingKey;
            routingKey = exchange;
            exchange = '';
        }
        const stream = new AmqpStreamSubscriber(this._channel, exchange, routingKey, options);
        this._subscribers.add(stream);
        stream.once('end', () => {
            this._subscribers.delete(stream);
        });
        return stream;
    }

    /**
     * @param {function(message: AmqpMessage, cb)} transformer
     * @return {stream.Transform}
     *
     * @example
     * const sub = amqp.subscriber('rpc_queue');
     * const pub = amqp.publisher({ contentType: 'text/plain' });
     * const transformer = AmqpClient.transformer((message, callback) => {
     *     const n = Number(message.content);
     *     callback(null, fibonacci(n).toString());
     * });
     * sub.pipe(transformer).pipe(pub);
     */
    static transformer(transformer) {
        return new AmqpStreamTransformer(transformer);
    }

    _connect() {
        async.retry(
            {
                /**
                 * The number of attempts to make before giving up.
                 * @private
                 */
                times: Infinity,
                /**
                 * The time to wait between retries, in milliseconds.
                 * Exponential backoff (i.e. intervals of 400, 800, 1600, 3200, 6400)
                 * @param {number} retryCount
                 * @returns {number}
                 * @private
                 */
                interval(retryCount) {
                    const timeout = 100 * (2 ** retryCount);
                    return timeout > 10000 ? 10000 : timeout;
                },
                /**
                 * If it returns true the retry attempts will continue;
                 * if the function returns false the retry flow is aborted with the current attempt's error
                 * and result being returned to the final callback.
                 * @param {Error} err
                 * @returns {boolean}
                 * @private
                 */
                errorFilter: (err) => {
                    if (/ACCESS-REFUSED/.test(err.message)) {
                        return false;
                    }
                    return !(this._ending || this._ended);
                },
            },
            /**
             * An async function to retry.
             * @param {function} cb
             * @private
             */
            (cb) => {
                // amqp calls callback function multiple times so `once` here
                amqp.connect(this._options.url, once(cb));
            },
            /**
             * Result callback
             * @param err
             * @param connection
             * @private
             */
            (err, connection) => {
                if (err) {
                    this.emit('error', new AmqpError(err.message, err));
                } else {
                    this._connection = connection;
                    this.emit('ready');
                }
            },
        );

        return this;
    }

    /**
     * Close AMQP connection
     *
     * @param {function} cb
     */
    close(cb = noopThrowIfError) {
        this._ending = true;
        this._subscribers.forEach((subscriber) => {
            subscriber.close();
        });
        this._publishers.forEach((publisher) => {
            publisher.end();
        });
        async.series([
            next => async.parallel([
                c => this._channel.end(c),
                c => this._confirmChannel.end(c),
            ], next),
            next => (this._connection ? this._connection.close(next) : next()),
        ], (err) => {
            this._ending = false;
            this._ended = true;
            cb(err);
        });
    }

    /**
     * Assert a queue into existence. This operation is idempotent given identical arguments;
     * however, it will bork the channel if the queue already exists but has different properties
     * (values supplied in the arguments field may or may not count for borking purposes).
     *
     * @see http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertQueue
     *
     * @param {string} queue
     *      Queue name, if you supply an empty string or other falsey value (including null and undefined),
     *      the server will create a random name for you.
     * @param {Object} [options]
     * @param {boolean} [options.exclusive = false]
     *      If true, scopes the queue to the connection
     * @param {boolean} [options.durable = true]
     *      If true, the queue will survive broker restarts, modulo the effects of exclusive and autoDelete
     * @param {boolean} [options.autoDelete = false]
     *      If true, the queue will be deleted when the number of consumers drops to zero.
     * @param {Object} [options.arguments]
     *      Additional arguments, usually parameters for some kind of broker-specific extension e.g.,
     *      high availability, TTL.
     * @param {number} [options.messageTtl]
     *      Expires messages arriving in the queue after n milliseconds
     * @param {number} [options.expires]
     *      The queue will be destroyed after n milliseconds of disuse
     * @param {string} [options.deadLetterExchange]
     *      An exchange to which messages discarded from the queue will be resent.
     *      A message is discarded when it expires or is rejected or nacked, or the queue limit is reached.
     * @param {number} [options.maxLength]
     *      Sets a maximum number of messages the queue will hold.
     *      Old messages will be discarded (dead-lettered if that's set) to make way for new messages.
     * @param {number} [options.maxPriority]
     *      Makes the queue a priority queue.
     * @param {function(err, {queue, messageCount, consumerCount})} [cb]
     */
    assertQueue(queue, options, cb = noopThrowIfError) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        this._channel.acquire((err, channel) => {
            if (err) cb(err);
            channel.assertQueue(queue, options, cb);
            this._channel.release(channel, noopThrowIfError);
        });
        return this;
    }

    /**
     * Check whether a queue exists. This will bork the channel if the named queue doesn't exist;
     * if it does exist, you go through to the next round!
     *
     * @see http://www.squaremobius.net/amqp.node/channel_api.html#channel_checkQueue
     *
     * @param queue
     * @param cb
     * @return {AmqpClient}
     */
    checkQueue(queue, cb = noopThrowIfError) {
        this._channel.acquire((err, channel) => {
            if (err) cb(err);
            channel.checkQueue(queue, cb);
            this._channel.release(channel, noopThrowIfError);
        });
        return this;
    }

    /**
     * Delete the queue named. Naming a queue that doesn't exist will result in the server closing the channel,
     * to teach you a lesson (except in RabbitMQ version 3.2.0 and after1).
     *
     * Note the obverse semantics of the options: if both are true, the queue will be deleted only
     * if it has no consumers and no messages.
     * You should leave out the options altogether if you want to delete the queue unconditionally.
     *
     * The server reply contains a single field, messageCount, with the number of messages deleted
     * or dead-lettered along with the queue.
     *
     * @see http://www.squaremobius.net/amqp.node/channel_api.html#channel-deletequeue
     *
     * @param {string} queue
     * @param {Object} [options]
     * @param {boolean} [options.ifUnused = false]
     *      If true and the queue has consumers, it will not be deleted and the channel will be closed.
     * @param {boolean} [options.ifEmpty = false]
     *      If true and the queue contains messages, the queue will not be deleted and the channel will be closed.
     * @param {function(err, {messageCount})} [cb]
     * @return {this}
     */
    deleteQueue(queue, options, cb = noopThrowIfError) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        this._channel.acquire((err, channel) => {
            if (err) cb(err);
            channel.deleteQueue(queue, options, cb);
            this._channel.release(channel, noopThrowIfError);
        });
        return this;
    }

    /**
     * Remove all undelivered messages from the queue named. Note that this won't remove messages
     * that have been delivered but not yet acknowledged; they will remain, and may be requeued
     * under some circumstances (e.g., if the channel to which they were delivered closes without acknowledging them).
     *
     * The server reply contains a single field, messageCount, containing the number of messages purged from the queue.
     *
     * @see http://www.squaremobius.net/amqp.node/channel_api.html#channel-purgequeue
     *
     * @param queue
     * @param {function(err, {messageCount})} [cb]
     * @return {this}
     */
    purgeQueue(queue, cb = noopThrowIfError) {
        this._channel.acquire((err, channel) => {
            if (err) cb(err);
            channel.purgeQueue(queue, cb);
            this._channel.release(channel, noopThrowIfError);
        });
        return this;
    }

    /**
     * Assert a routing path from an exchange to a queue: the exchange named by `source` will relay
     * messages to the `queue` named, according to the type of the exchange and the `pattern` given.
     * Pattern is a list of words, delimited by dots. The words can be anything, but usually they specify
     * some features connected to the message.
     *
     * There are two important special cases for binding keys:
     *
     * * `* (star)` can substitute for exactly one word,
     * * `# (hash)` can substitute for zero or more words.
     *
     * A few valid routing key examples: `"stock.usd.nyse"`, `"quick.orange.rabbit"`, `"*.*.rabbit"`.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel-bindqueue
     *      amqp.node — Channel#bindQueue}
     * @see {@link https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html
     *      rabbitmq.com/tutorials — Topic exchange}
     *
     * @param {string} queue
     *      The queue name
     * @param {string} source
     *      The exchange name
     * @param {string} pattern
     *      The routing key pattern
     * @param {Object} [argt]
     *      Is an object containing extra arguments that may be required for the particular exchange type.
     * @param {function} [cb]
     */
    bindQueue(queue, source, pattern, argt, cb = noopThrowIfError) {
        if (typeof argt === 'function') {
            cb = argt;
            argt = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.bindQueue(queue, source, pattern, argt, c),
            cb,
        );
    }

    /**
     * Remove a routing path between the queue named and the exchange named as source
     * with the pattern and arguments given.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_unbindQueue
     *      amqp.node — Channel#unbindQueue}
     *
     * @param {string} queue
     *      The queue name
     * @param {string} source
     *      The exchange name
     * @param {string} pattern
     *      The routing key pattern
     * @param {Object} [argt]
     *      Is an object containing extra arguments that may be required for the particular exchange type.
     * @param {function} [cb]
     */
    unbindQueue(queue, source, pattern, argt, cb = noopThrowIfError) {
        if (typeof argt === 'function') {
            cb = argt;
            argt = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.unbindQueue(queue, source, pattern, argt, c),
            cb,
        );
    }

    /**
     * Assert an exchange into existence. As with queues, if the exchange exists already and has properties
     * different to those supplied, the channel will 'splode; fields in the arguments object may or may not be 'splodey,
     * depending on the type of exchange. Unlike queues, you must supply a name, and it can't be the empty string.
     * You must also supply an exchange type, which determines how messages will be routed through the exchange.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertExchange
     *      amqp.node — Channel#assertExchange}
     * @see {@link https://www.rabbitmq.com/tutorials/amqp-concepts.html#exchanges
     *      rabbitmq.com/tutorials — Exchanges and Exchange Types}
     *
     * @param {string} exchange
     *      Exchange name
     * @param {'direct'|'fanout'|'topic'|'headers'} [type='direct']
     *      Exchange type
     * @param {Object} [options]
     * @param {boolean} [options.durable = true]
     *      If true, the exchange will survive broker restarts.
     * @param {boolean} [options.internal = false]
     *      If true, messages cannot be published directly to the exchange
     *      (i.e., it can only be the target of bindings, or possibly create messages ex-nihilo).
     * @param {boolean} [options.autoDelete = false]
     *      If true, the exchange will be destroyed once the number of bindings for which it is the source drop to zero.
     * @param {string} [options.alternateExchange]
     *      An exchange to send messages to if this exchange can't route them to any queues.
     * @param {Object} [options.arguments]
     *      Any additional arguments that may be needed by an exchange type.
     * @param {function} cb
     */
    assertExchange(exchange, type, options, cb = noopThrowIfError) {
        if (typeof type === 'function') {
            cb = type;
            type = 'direct';
            options = {};
        }
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.assertExchange(exchange, type, options, c),
            cb,
        );
    }

    /**
     * Check that an exchange exists. If it doesn't exist, the channel will be closed with an error.
     * If it does exist, happy days.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_checkExchange
     *      amqp.node — Channel#checkExchange}
     *
     * @param {string} exchange
     * @param {function(err)} cb
     */
    checkExchange(exchange, cb = noopThrowIfError) {
        leaseChannel(
            this._channel,
            (channel, c) => channel.checkExchange(exchange, c),
            cb,
        );
    }

    /**
     * Delete exchange, if the exchange does not exist, a channel error is raised
     * (RabbitMQ version 3.2.0 and after will not raise an error1).
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_deleteExchange
     *      amqp.node — Channel#deleteExchange}
     *
     * @param name
     * @param [options]
     * @param {boolean} [options.ifUnused]
     * @param [cb]
     */
    deleteExchange(name, options, cb = noopThrowIfError) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.deleteExchange(name, options, c),
            cb,
        );
    }

    /**
     * Bind an exchange to another exchange. The exchange named by destination will receive messages
     * from the exchange named by source, according to the type of the source and the pattern given.
     * For example, a direct exchange will relay messages that have a routing key equal to the pattern.
     *
     * NB Exchange to exchange binding is a RabbitMQ extension.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_bindExchange
     *      amqp.node — Channel#bindExchange}
     *
     * @param {string} destination
     *      The destination exchange
     * @param {string} source
     *      The source exchange
     * @param {string} pattern
     *      The routing key pattern
     * @param [args]
     * @param [cb]
     */
    bindExchange(destination, source, pattern, args, cb = noopThrowIfError) {
        if (typeof args === 'function') {
            cb = args;
            args = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.bindExchange(destination, source, pattern, args, c),
            cb,
        );
    }

    /**
     * Remove a binding from an exchange to another exchange. A binding with the exact source exchange,
     * destination exchange, routing key pattern, and extension args will be removed.
     * If no such binding exists, it's – you guessed it – a channel error, except in RabbitMQ >= version 3.2.0,
     * for which it succeeds trivially
     * {@link http://www.squaremobius.net/amqp.node/doc/channel_api.html#idempotent-deletes 1}.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_unbindExchange
     *      amqp.node — Channel#unbindExchange}
     *
     * @param {string} destination
     *      The destination exchange
     * @param {string} source
     *      The source exchange
     * @param {string} pattern
     *      The routing key pattern
     * @param [args]
     * @param [cb]
     */
    unbindExchange(destination, source, pattern, args, cb = noopThrowIfError) {
        if (typeof args === 'function') {
            cb = args;
            args = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.unbindExchange(destination, source, pattern, args, c),
            cb,
        );
    }

    /**
     * Ask a queue for a message, as an RPC. This will be resolved with either false,
     * if there is no message to be had (the queue has no messages ready),
     * or a message.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_get
     *      amqp.node — Channel#get}
     *
     * @param {string} queue
     * @param {Object} [options]
     * @param {function(?err: Error, ?message: AmqpMessage)} [cb]
     */
    get(queue, options, cb = noopThrowIfError) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        leaseChannel(
            this._channel,
            (channel, c) => channel.get(queue, options, c),
            cb,
        );
    }

    /**
     * Acknowledge all outstanding messages on the channel.
     * This is a "safe" operation, in that it won't result in an error even if there are no such messages.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_ackAll
     *      amqp.node — Channel#ackAll}
     *
     * @param cb
     */
    ackAll(cb = noopThrowIfError) {
        leaseChannel(
            this._channel,
            (channel, c) => channel.ackAll(c),
            cb,
        );
    }

    /**
     * Reject all messages outstanding on this channel. If requeue is truthy, or omitted,
     * the server will try to re-enqueue the messages.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_nackAll
     *      amqp.node — Channel#nackAll}
     *
     * @param cb
     */
    nackAll(cb = noopThrowIfError) {
        leaseChannel(
            this._channel,
            (channel, c) => channel.nackAll(c),
            cb,
        );
    }

    /**
     * Requeue unacknowledged messages on this channel. The server will reply (with an empty object)
     * once all messages are requeued.
     *
     * @see {@link http://www.squaremobius.net/amqp.node/channel_api.html#channel_recover
     *      amqp.node — Channel#recover}
     *
     * @param {function(err)} [cb]
     */
    recover(cb = noopThrowIfError) {
        leaseChannel(
            this._channel,
            (channel, c) => channel.recover(c),
            cb,
        );
    }
}

module.exports = AmqpClient;
