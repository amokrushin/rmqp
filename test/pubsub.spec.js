const test = require('tape');
const AmqpClient = require('..');
const { spy } = require('sinon');

const AMQP_URL = 'amqp://rmqp-rabbit';

test('content type', (group) => {
    const amqp = new AmqpClient(AMQP_URL);
    const q = 'iamrabbit';

    group.test('setup', (t) => {
        amqp.assertQueue(q, { durable: false });
        t.pass('ok');
        t.end();
    });

    group.test('text/plain', (t) => {
        const sub = amqp.subscriber(q, { noAck: true }).once('data', ({ content }) => {
            t.equal(typeof content, 'string', 'type of data is string');
            sub.close();
            sub.once('end', () => t.end());
        });
        const pub = amqp.publisher(q, { contentType: 'text/plain' });
        pub.end('foo');
    });

    group.test('application/json', (t) => {
        const sub = amqp.subscriber(q, { noAck: true }).once('data', ({ content }) => {
            t.ok(typeof content === 'object' && !(content instanceof Buffer), 'type of data is object');
            sub.close();
            sub.once('end', () => t.end());
        });
        const pub = amqp.publisher(q, { contentType: 'application/json' });
        pub.end({ foo: 'bar' });
    });

    group.test('application/octet-stream', (t) => {
        const sub = amqp.subscriber(q, { noAck: true }).once('data', ({ content }) => {
            t.ok(content instanceof Buffer, 'data is instance of Buffer');
            sub.close();
            sub.once('end', () => t.end());
        });
        const pub = amqp.publisher(q);
        pub.end(Buffer.from('foo'));
    });

    group.test('teardown', (t) => {
        amqp.close((err) => {
            if (err) {
                t.ifError(err);
            } else {
                t.pass('ok');
            }
            t.end();
        });
    });
});

test('stream', (group) => {
    const amqp = new AmqpClient(AMQP_URL);
    const q = 'iamrabbit';

    group.test('setup', (t) => {
        amqp.assertQueue(q, { durable: false });
        t.pass('ok');
        t.end();
    });

    group.test('pubsub', (t) => {
        const writable = amqp.publisher(q, { contentType: 'text/plain' });
        const readable = amqp.subscriber(q, { noAck: true });

        writable.on('error', (err) => {
            t.ifError(err);
        });
        readable.on('error', (err) => {
            t.ifError(err);
        });

        writable.write('1');
        writable.write('2');
        writable.write('3');
        writable.end();

        const onData = spy();

        readable.on('data', ({ content }) => {
            onData(content);
        });

        writable.once('finish', () => {
            setTimeout(() => {
                readable.close();
            }, 100);
        });

        readable.on('end', () => {
            t.ok(onData.firstCall.calledWith('1'), 'received 1');
            t.ok(onData.secondCall.calledWith('2'), 'received 2');
            t.ok(onData.thirdCall.calledWith('3'), 'received 3');
            t.end();
        });
    });

    group.test('teardown', (t) => {
        amqp.close((err) => {
            if (err) {
                t.ifError(err);
            } else {
                t.pass('ok');
            }
            t.end();
        });
    });
});

