const { Transform } = require('stream');

const { assign } = Object;

class AmqpStreamTransformer extends Transform {
    constructor(transformer) {
        super({ objectMode: true });
        this._transformer = transformer;
    }

    _transform(message, encoding, callback) {
        this._transformer(message, (err, result) => {
            if (err) return callback(err);
            callback(null, assign({}, message, { content: result }));
        });
    }
}

module.exports = AmqpStreamTransformer;
