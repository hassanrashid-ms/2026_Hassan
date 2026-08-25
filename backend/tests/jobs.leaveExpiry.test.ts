import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { runLeaveExpiry } from '../src/shared/jobs/leaveExpiry.ts';
import { closeOwnerPool, ownerPool, seedAgent, truncateAll } from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function setOnLeave(
  agentId: string,
  onLeaveUntil: Date | null,
  onLeaveSince: Date = daysAgo(10),
): Promise<void> {
  await ownerPool.query(
    `update agent set status = 'on_leave', on_leave_since = $2, on_leave_until = $3 where id = $1`,
    [agentId, onLeaveSince, onLeaveUntil],
  );
}

async function readAgent(agentId: string) {
  const { rows } = await ownerPool.query<{
    status: string;
    on_leave_since: Date | null;
    on_leave_until: Date | null;
  }>(`select status, on_leave_since, on_leave_until from agent where id = $1`, [agentId]);
  return rows[0]!;
}

describe('runLeaveExpiry', () => {
  it('clears leave and returns the agent to active once on_leave_until has passed', async () => {
    const agentId = await seedAgent();
    await setOnLeave(agentId, daysAgo(1));

    const count = await runLeaveExpiry({ now: NOW });

    expect(count).toBe(1);
    const row = await readAgent(agentId);
    expect(row.status).toBe('active');
    expect(row.on_leave_since).toBeNull();
    expect(row.on_leave_until).toBeNull();
  });

  it('leaves an agent whose return date is still in the future untouched', async () => {
    const agentId = await seedAgent();
    await setOnLeave(agentId, daysFromNow(2));

    const count = await runLeaveExpiry({ now: NOW });

    expect(count).toBe(0);
    const row = await readAgent(agentId);
    expect(row.status).toBe('on_leave');
    expect(row.on_leave_until).not.toBeNull();
  });

  it('leaves an agent on indefinite leave (no on_leave_until) untouched', async () => {
    const agentId = await seedAgent();
    await setOnLeave(agentId, null);

    const count = await runLeaveExpiry({ now: NOW });

    expect(count).toBe(0);
    const row = await readAgent(agentId);
    expect(row.status).toBe('on_leave');
  });

  it('is a no-op for an agent who is not on leave', async () => {
    const agentId = await seedAgent();

    const count = await runLeaveExpiry({ now: NOW });

    expect(count).toBe(0);
    const row = await readAgent(agentId);
    expect(row.status).toBe('active');
  });

  it('is idempotent — a second run finds nothing left to clear', async () => {
    const agentId = await seedAgent();
    await setOnLeave(agentId, daysAgo(1));

    await runLeaveExpiry({ now: NOW });
    const secondCount = await runLeaveExpiry({ now: NOW });

    expect(secondCount).toBe(0);
  });

  it('clears every expired agent across workspaces in one pass', async () => {
    const agentA = await seedAgent();
    const agentB = await seedAgent();
    await setOnLeave(agentA, daysAgo(1));
    await setOnLeave(agentB, daysAgo(5));

    const count = await runLeaveExpiry({ now: NOW });

    expect(count).toBe(2);
    expect((await readAgent(agentA)).status).toBe('active');
    expect((await readAgent(agentB)).status).toBe('active');
  });
});
