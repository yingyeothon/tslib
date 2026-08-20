import type { EventHandler, EventListenable } from "./types.js";

interface Registration<T> {
  handler: EventHandler<T>;
  once: boolean;
}

/**
 * A simple, type-safe event broker with asynchronous handlers.
 *
 * @template E An event map: keys are event names, values are event payloads.
 */
export interface EventBroker<E> extends EventListenable<E> {
  /**
   * Fire an event into the handlers that listen to it, in registration
   * order. Asynchronous handlers are awaited one by one; a rejected handler
   * rejects this method and skips the remaining handlers.
   *
   * Handlers are snapshotted before dispatch, so handlers added or removed
   * during dispatch take effect from the next `fire` call.
   *
   * @param name An event name in this event map.
   * @param event An event to fire.
   * @returns `true` if at least one handler was registered for this event.
   */
  fire<K extends keyof E>(name: K, event: E[K]): Promise<boolean>;
}

/**
 * Create a simple, type-safe event broker with asynchronous handlers.
 *
 * @example
 *
 * ```ts
 * interface MyEventMap {
 *   data: string;
 *   error: Error;
 * }
 * const broker = createEventBroker<MyEventMap>();
 * broker.on("data", console.log);
 * await broker.fire("data", "Hi, there!");
 * ```
 *
 * @template E An event map: keys are event names, values are event payloads.
 */
export function createEventBroker<E>(): EventBroker<E> {
  const registrations: {
    [K in keyof E]?: Array<Registration<E[K]>>;
  } = {};

  function add<K extends keyof E>(
    name: K,
    handler: EventHandler<E[K]>,
    once: boolean,
  ): EventBroker<E> {
    const list = (registrations[name] ??= []);
    list.push({ handler, once });
    return broker;
  }

  const broker: EventBroker<E> = {
    on: (name, handler) => add(name, handler, false),
    once: (name, handler) => add(name, handler, true),
    off: (name, handler) => {
      const list = registrations[name];
      if (list) {
        const index = list.findIndex(
          (registration) => registration.handler === handler,
        );
        if (index >= 0) {
          list.splice(index, 1);
        }
      }
      return broker;
    },
    fire: async (name, event) => {
      const list = registrations[name];
      if (!list || list.length === 0) {
        return false;
      }
      for (const registration of [...list]) {
        if (registration.once) {
          const index = list.indexOf(registration);
          if (index >= 0) {
            list.splice(index, 1);
          }
        }
        await registration.handler(event);
      }
      return true;
    },
  };
  return broker;
}
