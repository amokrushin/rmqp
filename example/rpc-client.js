#!/usr/bin/env node

const AmqpClient = require('rmqp');

const amqp = new AmqpClient(process.env.AMQP_URL);

const args = process.argv.slice(2);
const num = parseInt(args[0], 10);

if (!args.length) {
    console.log('Usage: rpc-client.js num');
    process.exit(1);
}

amqp.assertQueue('rpc_queue', { durable: false });

const sub = amqp.subscriber({ noAck: true });
const pub = amqp.publisher('rpc_queue', { contentType: 'text/plain', replyTo: sub });

sub.on('data', ({ content }) => {
    console.info(` [x] RPC client got '${content}'`);
    amqp.close();
});

console.info(` [x] RPC client requesting fib(${num})`);
pub.end(num.toString());
