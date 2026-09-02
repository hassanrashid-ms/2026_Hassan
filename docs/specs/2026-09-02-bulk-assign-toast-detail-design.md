# Bulk-assign toast detail

Status: draft
Date: 2026-09-02

## Problem

The Tickets tab's "Bulk assign" button (`Tickets.tsx`) runs
`POST /conversations/sweep-assign` (see
`docs/specs/2026-09-01-ticket-assignment-sweep-design.md`) and shows a single
generic toast: `toast.success(`Assigned ${assignedCount} tickets.`)`. When the
sweep assigns zero tickets — because no agent is online, every agent is at
capacity, or the workspace has no active agents at all — the agent sees
"Assigned 0 tickets." with no way to tell which of those is true, or whether
some tickets remain stuck versus the queue simply being empty already.

## Goal

Surface *why* the sweep stopped short of clearing the queue, and how many
tickets are still unassigned, so a Team Lead/Admin knows whether to wait, add
capacity, or bring an agent online.

## Non-goals

- Changing sweep behavior, ordering, or triggers — this only adds reporting to
  the existing `sweepUnassignedQueue` result.
- Distinguishing presence-check failure (Redis down) from "genuinely nobody
  online" — both already fail closed to "not eligible" in `pickEligibleAgent`,
  and stay merged under `none_online` here.

## Stop reasons

`pickEligibleAgent(tx, workspaceId)` currently returns `string | null`. It
returns:

```ts
{ agentId: string } | { agentId: null; reason: 'no_active_agents' | 'all_at_capacity' | 'none_online' }
```

- `no_active_agents`: no active, non-deactivated workspace member exists at
  all (a second query, run only when the capacity-filtered query returns zero
  rows, distinguishes this from the next case).
- `all_at_capacity`: active agents exist but every one is already at
  `workspace.maxAssignedTickets` live tickets (the existing `HAVING` clause
  filtered them all out).
- `none_online`: at least one active, under-capacity agent exists, but none
  show Redis presence `online` — including the fail-closed case where the
  presence batch read itself errors.

`assignNextTicket(workspaceId)` returns:

```ts
{ assigned: true; result: AssignNextTicketResult }
| { assigned: false; reason: 'queue_empty' | 'no_active_agents' | 'all_at_capacity' | 'none_online' }
```

`queue_empty` when there's no next unassigned conversation at all; otherwise
it forwards `pickEligibleAgent`'s reason.

`sweepUnassignedQueue(workspaceId)` loops until `assigned: false`, then runs
one final `countUnassigned` to report what's left, returning:

```ts
type SweepResult = {
  assignedCount: number;
  assignments: AssignNextTicketResult[];
  remainingCount: number;
  stopReason: 'queue_empty' | 'no_active_agents' | 'all_at_capacity' | 'none_online';
};
```

`remainingCount` is 0 whenever `stopReason` is `queue_empty` (barring a
concurrent insert landing between the loop's last iteration and the final
count, which is a normal race — a later sweep or presence trigger picks it up,
same as the existing iteration-cap race).

## API surface

`POST /conversations/sweep-assign` response body gains two fields:

```ts
{
  assignedCount: number;
  conversationIds: string[];
  remainingCount: number;
  stopReason: 'queue_empty' | 'no_active_agents' | 'all_at_capacity' | 'none_online';
}
```

Update the Zod response schema at `backend/src/docs/openapi.ts` (the
`sweep-assign` path registered around line 760) to match. No new route, no
version bump — additive field on an existing 200 response.

## Frontend

`agentApi.sweepAssign`'s return type gains `remainingCount` and `stopReason`.

`Tickets.tsx`'s `sweep` mutation's `onSuccess` replaces the flat success toast
with:

```ts
onSuccess: (result) => {
  void queryClient.invalidateQueries({ queryKey: ['tickets'] });
  void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
  if (result.stopReason === 'queue_empty' && result.assignedCount === 0) {
    toast.success('No unassigned tickets.');
  } else if (result.remainingCount === 0) {
    toast.success(`Assigned ${result.assignedCount} tickets.`);
  } else {
    toast.warning(
      `Assigned ${result.assignedCount} tickets. ${result.remainingCount} remain unassigned — ${reasonText(result.stopReason)}.`,
    );
  }
},
```

where `reasonText` maps:

| `stopReason` | text |
|---|---|
| `no_active_agents` | "no agents are assigned to this workspace" |
| `all_at_capacity` | "all agents are at capacity" |
| `none_online` | "no agents are online" |

(`queue_empty` never reaches `reasonText` — it's handled by the first branch.)

`onError` (network/permission failure) is unchanged.

## Testing

- Unit: `pickEligibleAgent` — asserts each of the three reasons independently
  (empty workspace membership, all members at capacity, members under capacity
  but none online, and the presence-batch-read-throws case also yields
  `none_online`).
- Unit: `assignNextTicket` — `queue_empty` when no unassigned conversation
  exists, forwards agent reason otherwise.
- Unit: `sweepUnassignedQueue` — `remainingCount` matches actual unassigned
  count after a partial sweep (e.g. 2 online agents both hit cap partway
  through a larger queue → `all_at_capacity`, `remainingCount > 0`).
- Frontend: `Tickets.test.tsx` — update existing `sweepAssign` mock to the new
  response shape; add a case per toast branch (empty queue, full drain,
  partial drain with each of the three reasons).
- OpenAPI schema updated to match the new response shape.
