/**
 * A very small external store.
 *
 * React is deliberately kept out of the hot path. Pose lands at ~25 Hz, the
 * blade is redrawn at 60 Hz, and the server broadcasts 20 times a second: run
 * any of that through `useState` and the whole component tree re-renders 100+
 * times a second for numbers that are being painted onto a canvas anyway.
 *
 * So the split is:
 *   - fast, continuous state (pose, blade, effects, health bars) lives in the
 *     runtime and is drawn directly to the canvas, never in React;
 *   - slow, discrete state (which screen, room code, lobby, result) lives here
 *     and re-renders components only when it genuinely changes.
 *
 * `useSyncExternalStore` is what makes that safe: it is tearing-free under
 * concurrent rendering, unlike a hand-rolled subscribe/setState pair.
 */

import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const key of Object.keys(next) as (keyof T)[]) {
        if (!Object.is(state[key], next[key])) {
          changed = true;
          break;
        }
      }
      // Bailing out on a no-op write matters: the network layer re-sets the
      // same connection status on every reconnect attempt, and without this
      // every one of those would re-render the tree.
      if (!changed) return;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Subscribe to one slice of a store.
 *
 * The selector must return something stable: a primitive, or an object/array
 * reference that only changes when the data does. Building a fresh object in a
 * selector produces an infinite render loop, so slices here are kept flat.
 */
export function useStoreValue<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(store.get()),
  );
}
