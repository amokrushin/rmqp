/**
 * AMQP message
 * @typedef {Object} AmqpMessage
 * @property {AmqpMessageFields} fields
 * @property {AmqpMessageProperties} properties
 * @property {Buffer} content
 * @property {function} ack
 * @property {function} nack
 */

/**
 * AMQP message fields
 * @typedef {Object} AmqpMessageFields
 * @property {string} consumerTag
 *       Identifies the consumer for which the message is destined
 * @property {number} deliveryTag
 *      A serial number for the message
 * @property {boolean} redelivered
 *      If true indicates that this message has been delivered before and been handed back to the server
 *      (e.g., by a nack or recover operation).
 * @property {string} exchange
 *      Name of exchange the message was published to
 * @property {string} routingKey
 *      The routing key (if any) used when published
 */

/**
 * AMQP message properties
 * @typedef {Object} AmqpMessageProperties
 * @property {string} contentType
 *      A MIME type for the message content.
 * @property {string} contentEncoding
 *      A MIME encoding for the message content.
 * @property {Object} headers
 *      Any user provided headers
 * @property {string} deliveryMode
 * @property {string} priority
 * @property {string} correlationId
 * @property {string} replyTo
 * @property {string} expiration
 * @property {string} messageId
 * @property {string} timestamp
 * @property {string} type
 * @property {string} userId
 * @property {string} appId
 * @property {string} clusterId
 */
