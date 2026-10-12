'use strict';

/**
 * Chrome/Firefox native-messaging stdio framing: a 32-bit little-endian length
 * prefix followed by a UTF-8 JSON payload.
 */

/** Create a stream parser that emits parsed JSON messages via onMessage. */
function createReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    // Each message: [uint32 LE length][JSON bytes]
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break; // wait for more
      const body = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (e) {
        onMessage({ type: 'error', error: 'bad json: ' + e.message });
      }
    }
  };
}

/** Serialize a message object into a length-prefixed buffer. */
function encode(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Write a message to a writable stream (e.g. process.stdout). */
function send(stream, message) {
  stream.write(encode(message));
}

module.exports = { createReader, encode, send };
