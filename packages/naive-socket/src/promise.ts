export interface DecomposedPromise<T> {
  promise: Promise<T>;
  isSettled: boolean;

  resolve: (result: T) => void;
  reject: (reason?: unknown) => void;
}

export function decomposePromise<T>(): DecomposedPromise<T> {
  const { promise, resolve, reject } = deconstruct<T>();
  let settled = false;
  return {
    promise,
    get isSettled() {
      return settled;
    },
    resolve: (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    },
    reject: (reason) => {
      if (!settled) {
        settled = true;
        reject(reason);
      }
    },
  };
}

function deconstruct<T>() {
  let resolve!: (result: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((newResolve, newReject) => {
    resolve = newResolve;
    reject = newReject;
  });
  return { promise, resolve, reject };
}
