export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const providers = ['opencode', 'claude'];
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max = 100000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function validateAsk(body) {
  if (!UUID.test(body.request_id) || !providers.includes(body.target_provider) || !providers.includes(body.provider) || !text(body.message) || !text(body.model, 200)) throw new Error('Invalid request, provider, model, or message.');
  if (body.source_session_id !== undefined && !text(body.source_session_id, 128)) throw new Error('Invalid source session ID.');
  const targetPattern = body.target_provider === 'opencode' ? /^ses_[A-Za-z0-9]+$/ : UUID;
  if (!text(body.session_id, 128) || !targetPattern.test(body.session_id)) throw new Error('Invalid target session ID.');
  if (body.provider === body.target_provider && body.source_session_id === body.session_id) throw new Error('Cannot ask the calling session itself.');
}
