class CustomError extends Error {
    constructor(message, err) {
        super(message);
        this.name = this.constructor.name;
        this.stack = err.stack;
    }
}
class AmqpError extends CustomError {}
class AmqpConnectionError extends CustomError {}
class AmqpChannelError extends CustomError {}

module.exports = {
    AmqpError,
    AmqpConnectionError,
    AmqpChannelError,
};
