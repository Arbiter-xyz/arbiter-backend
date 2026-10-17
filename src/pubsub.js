import { store } from './store.js';

const getClient = () => store.getClient();

/**
 * Pub/sub abstraction mirroring store.js's Memory/Redis split.
 *
 * When REDIS_URL is unset we fall back to an in-process emitter so that
 * single-instance behavior (and the existing test suite) is unaffected.
 * When Redis is configured, a dedicated duplicated connection is used for
 * pub/sub so it never blocks the main client's command pipeline.
 */

export class MemoryPubSub {
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

export class RedisPubSub {
  constructor(client = getClient()) {
    const base = client;
    if (!base) {
      throw new Error('RedisPubSub requires a configured Redis client');
    }
    // Dedicated connection: a subscribed client cannot issue normal commands.
    this.sub = typeof base.duplicate === 'function' ? base.duplicate() : base;
    this.pub = base;
    this.handlers = new Map();
    this.sub.on('error', (err) => {
      // Prevent unhandled 'error' events on the duplicated subscriber connection
      // from crashing the process during transient Redis disconnects.
      // eslint-disable-next-line no-console
      console.error('[pubsub] subscriber connection error', err);
    });
    this.sub.on('ready', () => {
      // Re-subscribe active channels after a reconnect so cross-instance
      // fan-out recovers automatically if subscription state was reset.
      for (const channel of this.handlers.keys()) {
        Promise.resolve(this.sub.subscribe(channel)).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[pubsub] resubscribe error', err);
        });
      }
    });
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
      Promise.resolve(this.sub.subscribe(channel)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[pubsub] subscribe error', err);
      });
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(channel);
        Promise.resolve(this.sub.unsubscribe(channel)).catch(() => {});
      }
    };
  }

  publish(channel, message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    Promise.resolve(this.pub.publish(channel, payload)).catch((err) => {
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

export function getPubSub() {
  if (instance) return instance;
  instance = process.env.REDIS_URL ? new RedisPubSub() : new MemoryPubSub();
  return instance;
}
