'use strict';

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function encodeNativeMessage(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

class NativeMessageDecoder {
  constructor(options = {}) {
    this.maxMessageBytes = options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageBytes) {
        throw new Error(`Native message exceeds max size: ${length} > ${this.maxMessageBytes}`);
      }
      if (this.buffer.length < 4 + length) {
        break;
      }

      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      messages.push(JSON.parse(body));
      this.buffer = this.buffer.subarray(4 + length);
    }

    return messages;
  }
}

module.exports = {
  DEFAULT_MAX_MESSAGE_BYTES,
  encodeNativeMessage,
  NativeMessageDecoder
};
