const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeNativeMessage,
  NativeMessageDecoder
} = require('../operator-daemon/framing');

test('encodeNativeMessage writes 32-bit little-endian length followed by JSON bytes', () => {
  const buffer = encodeNativeMessage({ type: 'PING', value: 1 });
  const length = buffer.readUInt32LE(0);
  const body = buffer.subarray(4).toString('utf8');

  assert.equal(length, Buffer.byteLength(body));
  assert.deepEqual(JSON.parse(body), { type: 'PING', value: 1 });
});

test('NativeMessageDecoder waits for partial messages', () => {
  const encoded = encodeNativeMessage({ type: 'HELLO' });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3, 7)), []);
  assert.deepEqual(decoder.push(encoded.subarray(7)), [{ type: 'HELLO' }]);
});

test('NativeMessageDecoder decodes multiple messages from one buffer', () => {
  const decoder = new NativeMessageDecoder();
  const combined = Buffer.concat([
    encodeNativeMessage({ id: 1 }),
    encodeNativeMessage({ id: 2 })
  ]);

  assert.deepEqual(decoder.push(combined), [{ id: 1 }, { id: 2 }]);
});

test('NativeMessageDecoder rejects oversized messages before allocation', () => {
  const decoder = new NativeMessageDecoder({ maxMessageBytes: 8 });
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(9, 0);

  assert.throws(
    () => decoder.push(buffer),
    /Native message exceeds max size/
  );
});
