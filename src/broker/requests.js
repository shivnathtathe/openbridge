import { createBridge } from '../adapters/opencode.js';
import { envelope, root } from '../core/runtime.js';
import { validateAsk } from '../core/validation.js';

/** Request acceptance, delivery ordering, persistence and target-lock transitions. */
export function createRequests(config, journal, services) {
  const { records, busy, persist } = journal;
  const { api, live, ensureOpenCode, ensureClaude } = services;
  const tasks = new Set();

  async function finish(record, status, fields) {
    Object.assign(record, fields, { status, updated_at: new Date().toISOString() });
    await persist(record);
    const key = `${record.target_provider}:${record.session_id}`;
    if (status !== 'unknown' && busy.get(key) === record.request_id) busy.delete(key);
  }

  async function dispatch(record) {
    try {
      if (record.sender.provider === 'opencode' && record.sender.session_id) {
        await ensureOpenCode();
        const source = await api(`/session/${encodeURIComponent(record.sender.session_id)}`);
        if (source.model?.id) record.sender = { ...record.sender, model: source.model.id, model_provider: source.model.providerID ?? null, attribution: 'opencode_api' };
      } else if (record.sender.provider === 'claude' && record.sender.session_id) {
        const source = live(record.sender.session_id);
        if (source) record.sender = { ...record.sender, model: source.metadata.model, attribution: 'claude_launch_configuration' };
      }
      if (record.target_provider === 'opencode') {
        await ensureOpenCode();
        record.delivery = 'submission_started';
        await persist(record);
        const ask = createBridge({ ...process.env, OPENCODE_BASE_URL: config.opencode.url, OPENCODE_DIRECTORY: root, ASK_OTHER_TIMEOUT_MS: String(config.request_timeout_ms) });
        const result = await ask(record.session_id, envelope(record.message, record.sender, record.request_id));
        await finish(record, 'completed', { reply: result.reply, receiver: { provider: 'opencode', model: result.model, model_provider: result.provider }, message_id: result.message_id });
      } else {
        await ensureClaude(record.session_id);
        record.delivery = 'queued';
        await persist(record);
      }
    } catch (error) {
      await finish(record, record.delivery === 'submission_started' ? 'unknown' : 'failed', { error: error.message });
    }
  }

  function assertNoCircularWait(body, targetKey) {
    if (!body.source_session_id) return;
    const sourceKey = `${body.provider}:${body.source_session_id}`;
    let cursor = targetKey;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      if (cursor === sourceKey) throw new Error('Circular wait detected. Reply to the pending request instead of calling back.');
      seen.add(cursor);
      const next = [...records.values()].find(record => record.status === 'pending' && record.sender.session_id && `${record.sender.provider}:${record.sender.session_id}` === cursor);
      cursor = next ? `${next.target_provider}:${next.session_id}` : null;
    }
  }

  async function ask(body) {
    validateAsk(body);
    const existing = records.get(body.request_id);
    if (existing) {
      if (existing.session_id !== body.session_id || existing.target_provider !== body.target_provider || existing.message !== body.message) throw new Error('Request ID already used for different content.');
      return existing;
    }
    const key = `${body.target_provider}:${body.session_id}`;
    if (busy.has(key)) throw new Error('Target has a pending or uncertain request. Check get_request before sending another.');
    assertNoCircularWait(body, key);
    if (records.size >= 500) throw new Error('Request journal limit reached (500). Archive completed records and restart the broker.');
    const record = {
      request_id: body.request_id, target_provider: body.target_provider, session_id: body.session_id,
      sender: { provider: body.provider, model: body.model, session_id: body.source_session_id ?? null, attribution: 'caller_supplied' },
      message: body.message, status: 'pending', delivery: 'not_sent', created_at: new Date().toISOString(),
    };
    records.set(record.request_id, record);
    busy.set(key, record.request_id);
    try { await persist(record); }
    catch (error) { records.delete(record.request_id); busy.delete(key); throw error; }
    const task = dispatch(record);
    tasks.add(task);
    task.catch(error => console.error('Request journal failure:', error.message)).finally(() => tasks.delete(task));
    return record;
  }

  return { ask, finish, drain: () => Promise.allSettled(tasks) };
}
