#!/usr/bin/env node

const AmqpClient = require('rmqp');

const amqp = new AmqpClient(process.env.AMQP_URL);

function fibonacci(n) {
    if (n === 0 || n === 1) {
        return n;
    }
    return fibonacci(n - 1) + fibonacci(n - 2);
}

amqp.assertQueue('rpc_queue', { durable: false });

const sub = amqp.subscriber('rpc_queue', { noAck: false, prefetch: 1 });
const pub = amqp.publisher({ contentType: 'text/plain' });
const transformer = AmqpClient.transformer((message, callback) => {
    const n = Number(message.content);
    message.ack();
    callback(null, fibonacci(n).toString());
});

sub.pipe(transformer).pipe(pub);

sub.once('ready', () => {
    console.info(' [x] Awaiting RPC requests. To exit press CTRL+C');
});
