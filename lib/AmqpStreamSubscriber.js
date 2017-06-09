const { Readable } = require('stream');

const { assign } = Object;

function noop() {}

/**
 * @param {AmqpMessage} message
 * @private
 */
function messageBodyParser(message) {
    switch (message.properties.contentType) {
        case 'application/json': {
            const body = message.content.toString(message.properties.contentEncoding);
            return JSON.parse(body);
        }
        case 'text/plain': {
            const body = message.content.toString(message.properties.contentEncoding);
            return body;
        }
        default:
            return message.content;
    }
}

/**
 * @param channel
 * @param {AmqpMessage} message
 * @private
 */
function mixinAckNack(channel, message) {
    message.ack = () => {
        channel.ack(message);
    };
    message.nack = (allUpTo, requeue) => {
        channel.ack(message, allUpTo, requeue);
    };
}

/**
 * @param {Pool} pool
 * @param {string} exchange
 * @param {string} routingKey
 * @param {Object} options
 * @return {null|boolean}
 * @private
 */
class AmqpStreamSubscriber extends Readable {
    constructor(pool, exchange, routingKey, options) {
        super({ objectMode: true });

        /**
         * @property {Pool}
         * @private
         */
        this._pool = pool;
        this._exchange = exchange;
        this._routingKey = routingKey;
        this._options = options;
        this._channel = null;
        this._consumerTag = null;
        this._queue = null;

        this._pool.acquire((err, channel) => {
            this._channel = channel;
            this.emit('connected');
            this._init();
        });
    }

    _read() {
        if (this._channel) {
            if (this._readableState.flowing) {
                if (!this._consumerTag) {
                    this._consume();
                }
            } else {
                throw new Error('Stream pull mode is not implementer');
            }
        } else {
            this.once('ready', () => {
                this._read();
            });
        }
    }

    _destroy(err, cb) {
        if (this._channel) {
            this._pool.destroy(this._channel, cb);
        } else {
            cb();
        }
    }

    close(cb = noop) {
        this._cancel((err) => {
            if (err) {
                this.push(null);
                this.destroy(err, cb);
            } else {
                this.push(null);
                cb();
            }
        });
    }

    _init() {
        const { _exchange, _routingKey, _channel } = this;

        if (_exchange === '' && _routingKey !== '') {
            this._queue = _routingKey;
            this.emit('ready');
        } else if (_exchange !== '') {
            _channel.assertQueue('', { exclusive: true }, (err, q) => {
                this._queue = q.queue;

                if (Array.isArray(_routingKey)) {
                    _routingKey.forEach(key => _channel.bindQueue(this._queue, _exchange, key));
                } else {
                    _channel.bindQueue(this._queue, _exchange, _routingKey);
                }
                this.emit('ready');
            });
        } else {
            _channel.assertQueue('', { exclusive: true }, (err, q) => {
                this._queue = q.queue;
                this.emit('ready');
            });
        }
    }

    _consume() {
        const { _queue, _options, _channel } = this;

        if (_options.prefetch) {
            _channel.prefetch(_options.prefetch);
        }

        _channel.consume(
            _queue,
            /**
             * @param {AmqpMessage} message
             * @private
             */
            (message) => {
                const content = messageBodyParser(message);
                if (!_options.noAck) {
                    mixinAckNack(_channel, message);
                }
                this.push(assign({}, message, { content }));
            },
            _options,
            (err, reply) => {
                if (err) {
                    this.destroy(err);
                } else {
                    this._consumerTag = reply.consumerTag;
                }
            },
        );
    }

    _get() {
        const { _queue, _options, _channel } = this;

        _channel.get(
            _queue,
            _options,
            /**
             * @param {?Error} err
             * @param {?AmqpMessage} message
             * @private
             */
            (err, message) => {
                if (err) {
                    this.destroy(err);
                } else if (message) {
                    const content = messageBodyParser(message);
                    if (!_options.noAck) {
                        mixinAckNack(_channel, message);
                    }
                    this.push(assign({}, message, { content }));
                }
            },
        );
    }

    _cancel(cb) {
        if (!this._consumerTag) {
            return;
        }
        this._channel.prefetch(false);
        this._channel.cancel(this._consumerTag, (err) => {
            if (err) {
                this._pool.destroy(this._channel, noop);
                cb(err);
            } else {
                this._pool.release(this._channel, cb);
            }
        });
    }
}

module.exports = AmqpStreamSubscriber;
