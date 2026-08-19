import type { EventHandler, EventListenable } from "./types.js";

interface Registration<T> {
  handler: EventHandler<T>;
  once: boolean;
}

/**
 * A simple, type-safe event broker with asynchronous handlers.
 *
 * @example
 *
 * ```ts
 * interface MyEventMap {
 *   data: string;
 *   error: Error;
 * }
 * class MyClass extends EventBroker<MyEventMap> {
 *   public doSomething = async () => {
 *     await this.fire("data", "Hi, there!");
 *   };
 * }
 * ```
 *
 * @template E An event map: keys are event names, values are event payloads.
 */
export class EventBroker<E> implements EventListenable<E> {
  /**
   * A map which contains registrations of handlers with their event name.
   */
  private readonly registrations: {
    [K in keyof E]?: Array<Registration<E[K]>>;
  } = {};

  /**
   * Listen to an event with a handler.
   *
   * @param name An event name in this event map.
   * @param handler A handler to process an event with this name.
   */
  public on = <K extends keyof E>(name: K, handler: EventHandler<E[K]>): this =>
    this.add(name, handler, false);

  /**
   * Listen to an event with a handler that is removed after its first call.
   *
   * @param name An event name in this event map.
   * @param handler A handler to process an event with this name, once.
   */
  public once = <K extends keyof E>(
    name: K,
    handler: EventHandler<E[K]>,
  ): this => this.add(name, handler, true);

  /**
   * Stop listening to an event. Removes the first registration (either `on`
   * or `once`) whose handler is identical to the given one.
   *
   * @param name An event name in this event map.
   * @param handler The handler that was previously registered.
   */
  public off = <K extends keyof E>(
    name: K,
    handler: EventHandler<E[K]>,
  ): this => {
    const list = this.registrations[name];
    if (list) {
      const index = list.findIndex(
        (registration) => registration.handler === handler,
      );
      if (index >= 0) {
        list.splice(index, 1);
      }
    }
    return this;
  };

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
  protected fire = async <K extends keyof E>(
    name: K,
    event: E[K],
  ): Promise<boolean> => {
    const list = this.registrations[name];
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
  };

  private add<K extends keyof E>(
    name: K,
    handler: EventHandler<E[K]>,
    once: boolean,
  ): this {
    const list = (this.registrations[name] ??= []);
    list.push({ handler, once });
    return this;
  }
}
