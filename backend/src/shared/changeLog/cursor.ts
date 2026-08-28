/**
 * The paging key for `change_log`, which is read newest-first by
 * (changed_at desc, id desc).
 *
 * Both halves are needed. `changed_at` is transaction start time, so every row a
 * single save writes shares one value — it is not unique. `id` alone is unique but
 * is not the requested order. The pair is a total order.
 *
 * `id` is carried as a string: it is a bigserial, so a JS number cannot hold it
 * safely and a JS bigint cannot be JSON-serialised.
 */
export type ChangeLogCursor = { changedAt: Date; id: string };

/** Digits only, and short enough that Postgres cannot overflow bigint on the cast. */
const ID_PATTERN = /^\d{1,19}$/;

/**
 * base64url of `<iso>|<id>`. Opaque on purpose: the format is not part of the API
 * contract, so paging can change shape later without a client change. Not
 * encryption — it hides nothing a caller could not already see in the response.
 */
export function encodeChangeLogCursor(cursor: ChangeLogCursor): string {
  return Buffer.from(`${cursor.changedAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Returns null for anything unparseable instead of throwing: a bad cursor is a
 * client mistake that the controller answers with a 422, and a decoder that
 * throws would turn a stale bookmark into a 500.
 */
export function decodeChangeLogCursor(raw: string): ChangeLogCursor | null {
  if (raw.length === 0 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) return null;

  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!ID_PATTERN.test(id)) return null;

  const changedAt = new Date(iso);
  if (Number.isNaN(changedAt.getTime())) return null;

  return { changedAt, id };
}
