import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MemoryPubSub, RedisPubSub, getPubSub } from '../src/pubsub.js';

function createFakeRedisClient() {
  const createNode = () => {
    const emitter = new EventEmitter();
    const subscribed = new Set();
    const published = [];
    const node = Object.assign(emitter, {
      subscribed,
      published,
      quitCalls: 0,
      async subscribe(channel) {
        subscribed.add(channel);
      },
      async unsubscribe(channel) {
        subscribed.delete(channel);
      },
      async publish(channel, payload) {
        published.push({ channel, payload });
      },
      async quit() {
        node.quitCalls += 1;
        subscribed.clear();
      },
    });
    return node;
  };

  const pubNode = createNode();
  const subNode = createNode();
  pubNode.duplicate = () => subNode;
  return { pubNode, subNode };
}

test('MemoryPubSub delivers string and serialized JSON payloads to subscribers and cleans up on unsubscribe', async () => {
  const bus = new MemoryPubSub();
  const receivedA = [];
  const receivedB = [];

  const unsubA = bus.subscribe('quorum:1', (msg) => receivedA.push(msg));
  const unsubB = bus.subscribe('quorum:1', (msg) => receivedB.push(msg));

  bus.publish('quorum:1', 'raw-string');
  bus.publish('quorum:1', { worker: 'W1', answer: 'yes' });

  assert.deepEqual(receivedA, ['raw-string', JSON.stringify({ worker: 'W1', answer: 'yes' })]);
  assert.deepEqual(receivedB, ['raw-string', JSON.stringify({ worker: 'W1', answer: 'yes' })]);

  unsubA();
  bus.publish('quorum:1', 'after-unsub-a');
  assert.equal(receivedA.length, 2);
  assert.equal(receivedB.length, 3);

  unsubB();
  assert.equal(bus.handlers.has('quorum:1'), false);

  await bus.close();
  assert.equal(bus.handlers.size, 0);
});

test('MemoryPubSub isolates throwing subscriber handlers so other subscribers still receive messages', () => {
  const bus = new MemoryPubSub();
  const received = [];

  bus.subscribe('chan', () => {
    throw new Error('boom');
  });
  bus.subscribe('chan', (msg) => received.push(msg));

  assert.doesNotThrow(() => bus.publish('chan', { ok: true }));
  assert.deepEqual(received, [JSON.stringify({ ok: true })]);
});

test('RedisPubSub throws when constructed without a configured Redis client', () => {
  assert.throws(() => new RedisPubSub(null), /requires a configured Redis client/);
});

test('RedisPubSub duplicates the base client, fans out messages, and unsubscribes when last handler leaves', async () => {
  const { pubNode, subNode } = createFakeRedisClient();
  const bus = new RedisPubSub(pubNode);

  assert.equal(bus.pub, pubNode);
  assert.equal(bus.sub, subNode);

  const received1 = [];
  const received2 = [];
  const unsub1 = bus.subscribe('job:42', (msg) => received1.push(msg));
  const unsub2 = bus.subscribe('job:42', (msg) => received2.push(msg));

  assert.equal(subNode.subscribed.has('job:42'), true);

  bus.publish('job:42', { status: 'settled' });
  assert.deepEqual(pubNode.published, [
    { channel: 'job:42', payload: JSON.stringify({ status: 'settled' }) },
  ]);

  subNode.emit('message', 'job:42', '{"status":"settled"}');
  assert.deepEqual(received1, ['{"status":"settled"}']);
  assert.deepEqual(received2, ['{"status":"settled"}']);

  // Unsubscribing first handler keeps the underlying Redis subscription active.
  unsub1();
  assert.equal(subNode.subscribed.has('job:42'), true);

  // Unsubscribing last handler unsubscribes the Redis channel.
  unsub2();
  assert.equal(subNode.subscribed.has('job:42'), false);
  assert.equal(bus.handlers.has('job:42'), false);

  await bus.close();
  assert.equal(subNode.quitCalls, 1);
});

test('RedisPubSub absorbs subscriber connection errors and re-subscribes active channels on ready reconnect', () => {
  const { pubNode, subNode } = createFakeRedisClient();
  const bus = new RedisPubSub(pubNode);

  bus.subscribe('chan:alpha', () => {});
  bus.subscribe('chan:beta', () => {});
  assert.deepEqual([...subNode.subscribed].sort(), ['chan:alpha', 'chan:beta']);

  // Simulate transient disconnect: emitting 'error' must not throw an unhandled EventEmitter error,
  // and losing channel state on the socket must be restored when 'ready' fires upon reconnect.
  subNode.subscribed.clear();
  assert.doesNotThrow(() => {
    subNode.emit('error', new Error('ECONNRESET'));
  });
  assert.equal(subNode.subscribed.size, 0);

  subNode.emit('ready');
  assert.deepEqual([...subNode.subscribed].sort(), ['chan:alpha', 'chan:beta']);
});

test('getPubSub returns a singleton MemoryPubSub when REDIS_URL is unset', () => {
  const first = getPubSub();
  const second = getPubSub();
  assert.equal(first, second);
  assert.equal(first instanceof MemoryPubSub, true);
});
