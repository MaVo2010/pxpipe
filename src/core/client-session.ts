/**
 * The client's own session id, read from the request's `metadata.user_id`.
 *
 * Claude Code sends `user_id` as a JSON string carrying `device_id`,
 * `account_uuid` and `session_id`; older builds sent the flat form
 * `user_<hash>_account_<uuid>_session_<uuid>`. Either way the session id is the
 * one stable key that every request of a CLI session shares — including the
 * short ones that never reach the history code, which is why the conversation
 * fingerprints (`first_user_sha8`, `session_state_sha8`) cover only a third of
 * the traffic. Telemetry only: the caller logs a hash of it, never the value.
 */
export function clientSessionId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const userId = (metadata as { user_id?: unknown }).user_id;
  if (typeof userId !== 'string' || userId === '') return undefined;
  if (userId.startsWith('{')) {
    try {
      const sid = (JSON.parse(userId) as { session_id?: unknown }).session_id;
      return typeof sid === 'string' && sid !== '' ? sid : undefined;
    } catch {
      return undefined;
    }
  }
  const m = /_session_([0-9a-fA-F-]{8,})$/.exec(userId);
  return m ? m[1] : undefined;
}
