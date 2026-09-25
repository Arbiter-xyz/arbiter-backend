'use strict';

const { getClient } = require('./store');

/**
 * Pub/sub abstraction mirroring store.js's Memory/Redis split.
 *
 * When REDIS_URL is unset we fall back to an in-process emitter so that
 * single-instance behavior (and the existing test suite) is unaffected.
 * When Redis is configured, a dedicated duplicated connection is used for
 * pub/sub so it never blocks the main client's command pipeline.
 */

class MemoryPubSub {
  constructor() {
    this.handlers = new Map();
  }

  subscribe(channel, handler) {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(channel);
    };
  }

  publish(channel, message) {
    const set = this.handlers.get(channel);
    if (!set) return;
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        // A misbehaving subscriber must not break the publisher.
        // eslint-disable-next-line no-console
        console.error('[pubsub] handler error', err);
      }
    }
  }

  async close() {
    this.handlers.clear();
  }
}

class RedisPubSub {
  constructor() {
    const base = getClient();
    if (!base) {
      throw new Error('RedisPubSub requires a configured Redis client');
    }
    // Dedicated connection: a subscribed client cannot issue normal commands.
    this.sub = typeof base.duplicate === 'function' ? base.duplicate() : base;
    this.pub = base;
    this.handlers = new Map();
    this.sub.on('message', (channel, message) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const handler of set) {
        try {
          handler(message);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[pubsub] handler error', err);
        }
      }
    });
  }

  subscribe(channel, handler) {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      this.sub.subscribe(channel).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[pubsub] subscribe error', err);
      });
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  publish(channel, message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    this.pub.publish(channel, payload).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[pubsub] publish error', err);
    });
  }

  async close() {
    this.handlers.clear();
    try {
      await this.sub.quit();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[pubsub] close error', err);
    }
  }
}

let instance = null;

function getPubSub() {
  if (instance) return instance;
  instance = process.env.REDIS_URL ? new RedisPubSub() : new MemoryPubSub();
  return instance;
}

module.exports = { getPubSub, MemoryPubSub, RedisPubSub };
