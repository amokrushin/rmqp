# rmqp
[![NPM Stable Version][npm-stable-version-image]][npm-url]
[![Build Status][travis-master-image]][travis-url]
[![Test Coverage][codecov-image]][codecov-url-master]
[![Dependency Status][david-image]][david-url-master]
[![Node.js Version][node-version-image]][node-version-url]
[![License][license-image]][license-url]

Some sugar for [amqp.node][github-amqp-node] library

## Features

* channel pool
* [`channel.publish`][amqp-node-publish] and [`channel.sendToQueue`][amqp-node-sendtoqueue] replaced with a [Writable][node-api-stream-writable] stream
* [`channel.consume`][amqp-node-consume] replaced with a [Readable][node-api-stream-readable] stream


## Install
    npm i rmqp

## Usage

RabbitMQ [Tutorials][tutorials-spec]

### Job queue

#### Publisher

```js
const amqp = new AmqpClient(AMQP_URL);
amqp.assertQueue('job_queue');

const publisher = amqp.publisher(q, { contentType: 'application/json' });

publisher.write({taskId: 1, ...});
publisher.write({taskId: 2, ...});
publisher.end();
```

#### Worker

```js
const amqp = new AmqpClient(AMQP_URL);
amqp.assertQueue('task_queue');

amqp.subscriber(q, { noAck: false, prefetch: 1 })
    .on('data', (message) => {
        ...
        message.ack();
    });
```

## API

[Documentation](https://amokrushin.github.io/rmqp)


[npm-stable-version-image]: https://img.shields.io/npm/v/rmqp.svg
[npm-url]: https://npmjs.com/package/rmqp
[travis-master-image]: https://img.shields.io/travis/amokrushin/rmqp/master.svg
[travis-url]: https://travis-ci.org/amokrushin/rmqp
[codecov-image]: https://img.shields.io/codecov/c/github/amokrushin/rmqp/master.svg
[codecov-url-master]: https://codecov.io/github/amokrushin/rmqp?branch=master
[david-image]: https://img.shields.io/david/amokrushin/rmqp.svg
[david-url-master]: https://david-dm.org/amokrushin/rmqp
[node-version-image]: https://img.shields.io/node/v/rmqp.svg
[node-version-url]: https://nodejs.org/en/download/
[license-image]: https://img.shields.io/npm/l/rmqp.svg
[license-url]: https://raw.githubusercontent.com/amokrushin/rmqp/master/LICENSE

[github-amqp-node]:https://github.com/squaremo/amqp.node
[node-api-stream-readable]:https://nodejs.org/dist/latest-v8.x/docs/api/stream.html#stream_readable_streams
[node-api-stream-writable]:https://nodejs.org/dist/latest-v8.x/docs/api/stream.html#stream_writable_streams
[amqp-node-publish]:http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish
[amqp-node-sendtoqueue]:http://www.squaremobius.net/amqp.node/channel_api.html#channel_sendToQueue
[amqp-node-consume]:http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume
[tutorials-spec]:https://github.com/amokrushin/rmqp/blob/master/test/tutorials.spec.js