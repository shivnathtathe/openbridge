/** Forward a prompt to OpenCode's native send-and-wait API. */
export function createBridge(env = process.env) {
  const base = new URL(env.OPENCODE_BASE_URL || 'http://localhost:4096');
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('OPENCODE_BASE_URL must use HTTP or HTTPS.');
  }
  const timeoutMs = Number(env.ASK_OTHER_TIMEOUT_MS || 180000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('ASK_OTHER_TIMEOUT_MS must be a positive integer.');
  }
  const active = new Set();

  async function request(path, options, signal) {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    if (env.OPENCODE_DIRECTORY) url.searchParams.set('directory', env.OPENCODE_DIRECTORY);
    const headers = { 'Content-Type': 'application/json' };
    if (env.OPENCODE_SERVER_PASSWORD) {
      const credentials = `${env.OPENCODE_SERVER_USERNAME || 'opencode'}:${env.OPENCODE_SERVER_PASSWORD}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    let response;
    try {
      response = await fetch(url, { ...options, headers, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('OpenCode connection failed. If a prompt was submitted, check the target session before retrying.');
    }
    if (!response.ok) {
      // Do not echo arbitrary server responses, which may contain credentials.
      throw new Error(`OpenCode HTTP ${response.status} ${response.statusText} (${path}).`);
    }
    return response.json();
  }

  return async function askOther(sessionId, message, callerSignal) {
    if (typeof sessionId !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid OpenCode session_id.');
    if (typeof message !== 'string' || !message.trim()) throw new Error('message must not be blank.');
    if (sessionId === env.OPENCODE_CALLER_SESSION_ID) {
      throw new Error('Cannot ask the calling session itself. Choose another session.');
    }
    if (active.has(sessionId)) throw new Error('This bridge already has a request pending for that session.');
    active.add(sessionId);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    let submitted = false;
    try {
      const statuses = await request('/session/status', { method: 'GET' }, signal);
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) throw new Error('Unexpected OpenCode status response.');
      const status = statuses[sessionId]?.type;
      if (Object.hasOwn(statuses, sessionId) && !['idle', 'busy', 'retry'].includes(status)) throw new Error('Malformed target session status.');
      if (status && status !== 'idle') {
        throw new Error(`Target session is ${status}. Wait until it is idle before asking it.`);
      }
      submitted = true;
      const result = await request(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        body: JSON.stringify({ parts: [{ type: 'text', text: message }] }),
      }, signal);
      if (!result || typeof result !== 'object') throw new Error('OpenCode returned an unexpected assistant response.');
      if (result.info?.error) {
        throw new Error(`Target session reported an assistant error (${result.info.error.name || 'unknown'}).`);
      }
      if (result.info?.role !== 'assistant' || !result.info?.id || !Array.isArray(result.parts)) {
        throw new Error('OpenCode returned an unexpected assistant response.');
      }
      const reply = result.parts
        .filter(part => part.type === 'text' && !part.ignored && typeof part.text === 'string')
        .map(part => part.text).join('\n\n');
      return {
        session_id: sessionId,
        message_id: result.info.id,
        provider: result.info.providerID ?? null,
        model: result.info.modelID ?? null,
        reply,
      };
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`${deadline.aborted ? `Timed out after ${timeoutMs}ms` : 'Request cancelled'}. ${submitted ? 'The prompt may already have been accepted; check the target session before retrying. The bridge did not explicitly abort the target; it may still be running.' : 'No prompt was submitted.'}`);
      }
      throw error;
    } finally {
      active.delete(sessionId);
    }
  };
}
