const test = require('tape');
const async = require('async');
const AmqpClient = require('..');
const EventEmitter = require('events');

const AMQP_URL = 'amqp://rmqp-rabbit';

function waitEventsThen(ee, events, callback) {
    async.each(events, (event, cb) => ee.once(event, cb), (err) => {
        if (err) return callback(err);
        setTimeout(callback, 50);
    });
}

function waitAllCbThen(next) {
    const cbs = [];
    process.nextTick(() => async.parallel(cbs, next));
    return cb => cbs.push(cb);
}

/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-one-javascript.html
 */
test('1 "Hello World!"', (t) => {
    t.pass(2 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });

    /* Publisher */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'hello';
        amqp.assertQueue(q, { durable: false });

        amqp.publisher(q, { persistent: true, contentType: 'text/plain' })
            .once('finish', () => {
                t.pass('Sent "Hello World!"');
            })
            .end('Hello World!');

        wait(cb => setTimeout(() => amqp.close(cb), 200));
    }

    /* Subscriber */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'hello';
        amqp.assertQueue(q, { durable: false });

        amqp.subscriber(q, { noAck: true })
            .on('data', ({ content }) => {
                t.equal(content, 'Hello World!', 'Received "Hello World!"');
            });

        wait(cb => setTimeout(() => amqp.close(cb), 200));
    }
});

/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-two-javascript.html
 */
test('2 Work queues', (t) => {
    t.plan(5 + 5 + 5 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });


    /* Task publisher */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'task_queue';
        amqp.assertQueue(q, { durable: true });

        const publisher = amqp.publisher(q, { persistent: true, contentType: 'text/plain' });
        publisher.write('First message.');
        t.pass('[x] Publisher sent \'First message.\'');
        publisher.write('Second message..');
        t.pass('[x] Publisher sent \'Second message..\'');
        publisher.write('Third message...');
        t.pass('[x] Publisher sent \'Third message...\'');
        publisher.write('Fourth message....');
        t.pass('[x] Publisher sent \'Fourth message....\'');
        publisher.write('Fifth message.....');
        t.pass('[x] Publisher sent \'Fifth message.....\'');
        publisher.end();

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Worker 1 */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'task_queue';
        amqp.assertQueue(q, { durable: true });

        amqp.subscriber(q, { noAck: false, prefetch: 1 })
            .on('data', (message) => {
                t.pass(` [x] Worker 1 received '${message.content}'`);

                const timeout = message.content.split('.').length - 1;

                setTimeout(() => {
                    t.pass(' [x] Done');
                    message.ack();
                }, timeout * 10);
            });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Worker 2 */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'task_queue';
        amqp.assertQueue(q, { durable: true });

        amqp.subscriber(q, { noAck: false, prefetch: 1 })
            .on('data', (message) => {
                t.pass(` [x] Worker 2 received '${message.content}'`);

                const timeout = message.content.split('.').length - 1;

                setTimeout(() => {
                    t.pass(' [x] Done');
                    message.ack();
                }, timeout * 10);
            });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }
});

/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-three-javascript.html
 */
test('3 Publish/Subscribe', (t) => {
    t.plan(3 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });
    const ee = new EventEmitter();


    /* Emitter */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'logs';
        const msg = 'Hello World!';
        amqp.assertExchange(ex, 'fanout', { durable: false });

        const publisher = amqp.publisher(ex, '', { persistent: true, contentType: 'text/plain' });

        waitEventsThen(ee, ['receiver 1 ready', 'receiver 2 ready'], () => {
            t.pass(`[x] Publisher sent '${msg}'`);
            publisher.end(msg);
        });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 1 */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'logs';
        amqp.assertExchange(ex, 'fanout', { durable: false });

        const receiver = amqp.subscriber(ex, '', { noAck: true })
            .on('data', ({ content }) => {
                t.pass(` [x] Receiver 1 received '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 2 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 2 */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'logs';
        amqp.assertExchange(ex, 'fanout', { durable: false });

        const receiver = amqp.subscriber(ex, '', { noAck: true })
            .on('data', ({ content }) => {
                t.pass(` [x] Receiver 2 received '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 1 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }
});

/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-four-javascript.html
 */
test('4 Routing', (t) => {
    t.plan(2 + 1 + 2 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });
    const ee = new EventEmitter();


    /* Emitter */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'direct_logs';
        const msgInfo = 'Hello World!';
        const msgError = 'Run. Run. Or it will explode.';
        amqp.assertExchange(ex, 'direct', { durable: false });

        const logger = {
            info: amqp.publisher(ex, 'info', { contentType: 'text/plain' }),
            error: amqp.publisher(ex, 'error', { contentType: 'text/plain' }),
        };

        waitEventsThen(ee, ['receiver 1 ready', 'receiver 2 ready'], () => {
            logger.info.end(msgInfo);
            t.pass(`[x] Publisher sent info: '${msgInfo}'`);
            logger.error.end(msgError);
            t.pass(`[x] Publisher sent error: '${msgError}'`);
        });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 1 [error] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'direct_logs';
        amqp.assertExchange(ex, 'direct', { durable: false });

        const receiver = amqp.subscriber(ex, 'error', { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 1 received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 2 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 2 [info,error,warning] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'direct_logs';
        amqp.assertExchange(ex, 'direct', { durable: false });

        const receiver = amqp.subscriber(ex, ['info', 'error', 'warning'], { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 2 received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 1 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }
});

/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-five-javascript.html
 */
test('5 Topics', (t) => {
    t.plan(2 + 2 + 1 + 2 + 2 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });
    const ee = new EventEmitter();


    /* Emitter */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'topic_logs';
        const msgKernCritical = 'A critical kernel error';
        const msgIoCritical = 'A critical IO error';
        amqp.assertExchange(ex, 'topic', { durable: false });

        const kern = {
            critical: amqp.publisher(ex, 'kern.critical', { contentType: 'text/plain' }),
        };
        const io = {
            critical: amqp.publisher(ex, 'io.critical', { contentType: 'text/plain' }),
        };

        waitEventsThen(ee, ['receiver 1 ready', 'receiver 2 ready', 'receiver 3 ready', 'receiver 4 ready'], () => {
            kern.critical.end(msgKernCritical);
            t.pass(`[x] Publisher sent kern.critical: '${msgKernCritical}'`);
            io.critical.end(msgIoCritical);
            t.pass(`[x] Publisher sent io.critical: '${msgIoCritical}'`);
        });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 1: all the logs [#] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'topic_logs';
        const key = '#';
        amqp.assertExchange(ex, 'topic', { durable: false });

        const receiver = amqp.subscriber(ex, key, { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 1 [#] received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 1 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 2: logs from the facility "kern" [kern.*] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'topic_logs';
        const key = 'kern.*';
        amqp.assertExchange(ex, 'topic', { durable: false });

        const receiver = amqp.subscriber(ex, key, { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 2 [kern.*] received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 2 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 3: only "critical" logs [*.critical] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'topic_logs';
        const key = '*.critical';
        amqp.assertExchange(ex, 'topic', { durable: false });

        const receiver = amqp.subscriber(ex, key, { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 3 [*.critical] received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 3 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* Receiver 4: "kern" and "critical" logs [kern.*, *.critical] */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const ex = 'topic_logs';
        const key = ['kern.*', '*.critical'];
        amqp.assertExchange(ex, 'topic', { durable: false });

        const receiver = amqp.subscriber(ex, key, { noAck: true })
            .on('data', ({ content, fields }) => {
                t.pass(` [x] Receiver 4 [kern.*, *.critical] received ${fields.routingKey}: '${content}'`);
            });

        receiver.once('ready', () => ee.emit('receiver 4 ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }
});


/**
 * @see https://www.rabbitmq.com/tutorials/tutorial-six-javascript.html
 */
test('6 RPC', (t) => {
    t.plan(2 + 1);
    const wait = waitAllCbThen((err) => {
        t.pass('end');
        t.end(err);
    });
    const ee = new EventEmitter();

    /* RPC server */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'rpc_queue';
        amqp.assertQueue(q, { durable: false });

        const fibonacci = n => ((n === 0 || n === 1) ? n : fibonacci(n - 1) + fibonacci(n - 2));

        const sub = amqp.subscriber(q, { noAck: false, prefetch: 1 });
        const pub = amqp.publisher({ contentType: 'text/plain' });
        const transformer = AmqpClient.transformer((message, callback) => {
            const n = Number(message.content);
            message.ack();
            callback(null, fibonacci(n).toString());
        });

        sub.pipe(transformer).pipe(pub);

        sub.once('ready', () => ee.emit('rpc server ready'));

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }


    /* RPC client */
    {
        const amqp = new AmqpClient(AMQP_URL);
        const q = 'rpc_queue';
        const n = 30;
        amqp.assertQueue(q, { durable: false });

        const sub = amqp.subscriber({ noAck: true });
        const pub = amqp.publisher(q, { contentType: 'text/plain', replyTo: sub });

        sub.on('data', ({ content }) => {
            t.equal(content, '832040', `[x] RPC client got '${content}'`);
        });

        waitEventsThen(ee, ['rpc server ready'], () => {
            t.pass(`[x] RPC client requesting fib(${n})`);
            pub.end(n.toString());
        });

        wait(cb => setTimeout(() => amqp.close(cb), 2000));
    }
});

/*
 *      client
 *      consume exclusive cSub -> cPub to rpc_queue repllyTo cSub
 *
 *      server
 *      consume sSub from rpc_queue -> transform -> sPub publish to message replyTo
 *      sub -> transform -> pub
 */
