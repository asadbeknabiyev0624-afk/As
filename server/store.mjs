import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export function initialState() {
  return {
    profile: { name: '', aboutMe: '', preferences: '' },
    notes: [], tasks: [], messages: [],
    settings: { model: 'qwen2.5:1.5b' },
  };
}

export async function createStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'state.json');
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (!state.profile || !state.settings || !Array.isArray(state.notes) ||
        !Array.isArray(state.tasks) || !Array.isArray(state.messages)) {
      throw new Error('Unexpected saved-data format. Back up state.json before repairing it.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot load personal data: ${error.message}`);
    state = initialState();
  }
  let pending = Promise.resolve();
  return {
    get: () => structuredClone(state),
    mutate(update) {
      const operation = pending.then(async () => {
        const next = structuredClone(state);
        update(next);
        const temporary = `${file}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
        state = next;
        return structuredClone(state);
      });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
