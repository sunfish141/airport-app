export const TAG_KEY = 'carry.remembered-tag.v1';

// Hydrate before starting the shared UI. Serialize native writes so a slow
// save cannot overwrite a later Disconnect or Forget operation.
export async function createTagStorage(preferences, onError = () => {}) {
  let value = (await preferences.get({ key: TAG_KEY })).value;
  let tail = Promise.resolve();
  function enqueue(operation) { tail = tail.then(operation).catch(onError); }
  return {
    getItem(key) { return key === TAG_KEY ? value : null; },
    setItem(key, next) {
      if (key !== TAG_KEY) return;
      value = next;
      enqueue(() => preferences.set({ key, value: next }));
    },
    removeItem(key) {
      if (key !== TAG_KEY) return;
      value = null;
      enqueue(() => preferences.remove({ key }));
    },
    flush() { return tail; },
  };
}
