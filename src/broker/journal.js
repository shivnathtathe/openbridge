import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, stateDir } from '../core/runtime.js';
import { UUID } from '../core/validation.js';

/** Disk storage and conservative recovery; request transitions belong to requests.js. */
export async function openJournal() {
  const directory = resolve(stateDir, 'requests');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = new Map();
  const busy = new Map();
  const persist = record => atomicJson(resolve(directory, `${record.request_id}.json`), record);

  for (const file of await readdir(directory)) {
    if (!UUID.test(file.replace(/\.json$/, ''))) continue;
    const record = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
    if (!UUID.test(record?.request_id) || `${record.request_id}.json` !== file) throw new Error(`Invalid journal record ${file}; inspect it before restarting.`);
    if (record.status === 'pending') {
      record.status = 'unknown';
      record.error = 'Broker restarted during this request; execution state is unknown. Do not resend automatically.';
      await persist(record);
    }
    records.set(record.request_id, record);
    if (record.status === 'unknown') busy.set(`${record.target_provider}:${record.session_id}`, record.request_id);
  }
  return { records, busy, persist };
}
