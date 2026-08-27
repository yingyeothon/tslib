export type Unsubscribe = () => void;

export type EventHandler<T> = (payload: T) => void;

export interface Emitter<TEvents extends Record<string, unknown>> {
  on<K extends keyof TEvents>(
    type: K,
    handler: EventHandler<TEvents[K]>,
  ): Unsubscribe;
  emit<K extends keyof TEvents>(type: K, payload: TEvents[K]): void;
}

export function createEmitter<
  TEvents extends Record<string, unknown>,
>(): Emitter<TEvents> {
  const handlers = new Map<keyof TEvents, Set<EventHandler<never>>>();
  return {
    on(type, handler) {
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (set === undefined) {
        return;
      }
      for (const handler of [...set]) {
        (handler as EventHandler<typeof payload>)(payload);
      }
    },
  };
}
