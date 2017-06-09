const { Writable } = require('stream');
const async = require('async');

const { assign } = Object;

function waitThenEmit(ee, srcEvents, destEvent, timeoutMs = 5000) {
    async.each(
        srcEvents,
        async.timeout((event, cb) => ee.once(event, cb), timeoutMs),
        (err) => {
            if (err) return ee.emit('error', err);
            ee.emit(destEvent);
        },
    );
}

function emitNextTick(ee, event, ...args) {
    process.nextTick(() => ee.emit(event, ...args));
}

function contentToBuffer(contentType, content) {
    switch (contentType) {
        case 'application/json': {
            return Buffer.from(JSON.stringify(content));
        }
        case 'text/plain': {
            return Buffer.from(content);
        }
        default:
            return content;
    }
}

/**
 * @param {Pool} pool
 * @param {string} exchange
 * @param {string} routingKey
 * @param {Object} [options]
 * @private
 */
class AmqpStreamPublisher extends Writable {
    constructor(pool, exchange, routingKey, options = {}) {
        super({ objectMode: true });
        this._pool = pool;
        this._exchange = exchange;
        this._routingKey = routingKey;
        this._options = options;
        this._channel = null;
        this._waitFor = [];

        if (typeof options.replyTo === 'object' && options.replyTo.constructor.name === 'AmqpStreamSubscriber') {
            const subscriber = options.replyTo;
            if (subscriber._queue) {
                this._options.replyTo = subscriber._queue;
                emitNextTick(this, 'subscriber');
            } else {
                subscriber.once('ready', () => {
                    this._options.replyTo = subscriber._queue;
                    emitNextTick(this, 'subscriber');
                });
            }
            this._waitFor.push('subscriber');
        }

        this._waitFor.push('channel');
        this._pool.acquire((err, channel) => {
            this._channel = channel;
            emitNextTick(this, 'channel');
        });

        waitThenEmit(this, this._waitFor, 'ready');
    }

    _write(chunk, encoding, callback) {
        if (!this._channel) {
            this.once('ready', () => {
                this._write(chunk, encoding, callback);
            });
        } else {
            let routingKey;
            let content;
            let options;
            if (this._exchange !== '' || this._routingKey !== '') {
                routingKey = this._routingKey;
                content = contentToBuffer(this._options.contentType, chunk);
                options = this._options;
            } else if (chunk.properties.replyTo !== '') {
                content = chunk.content;
                routingKey = chunk.properties.replyTo;
                options = assign({}, this._options, { correlationId: chunk.properties.correlationId });
            } else {
                callback(new Error('Empty target routing key'));
            }
            const drain = this._channel.publish(this._exchange, routingKey, Buffer.from(content), options);
            if (drain) {
                callback();
            } else {
                this._channel.once('drain', callback);
            }
        }
    }

    _final(callback) {
        this._pool.release(this._channel, callback);
    }
}

module.exports = AmqpStreamPublisher;
