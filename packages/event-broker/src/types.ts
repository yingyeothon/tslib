/**
 * A handler for a single event. It may return a promise, in which case the
 * broker awaits it before invoking the next handler.
 */
export type EventHandler<T> = (event: T) => unknown;

/**
 * The listener-facing surface of an event broker, typed by an event map.
 *
 * @template E An event map: keys are event names, values are event payloads.
 */
export interface EventListenable<E> {
  /**
   * Listen to an event with a handler.
   *
   * @param name An event name in this event map.
   * @param handler A handler to process an event with this name.
   */
  on<K extends keyof E>(name: K, handler: EventHandler<E[K]>): this;

  /**
   * Listen to an event with a handler that is removed after its first call.
   *
   * @param name An event name in this event map.
   * @param handler A handler to process an event with this name, once.
   */
  once<K extends keyof E>(name: K, handler: EventHandler<E[K]>): this;

  /**
   * Stop listening to an event. Removes the first registration (either `on`
   * or `once`) whose handler is identical to the given one.
   *
   * @param name An event name in this event map.
   * @param handler The handler that was previously registered.
   */
  off<K extends keyof E>(name: K, handler: EventHandler<E[K]>): this;
}
