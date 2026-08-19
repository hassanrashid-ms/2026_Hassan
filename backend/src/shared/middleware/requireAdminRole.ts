import { requireWorkspaceRole } from './requireWorkspaceRole.ts'

/**
 * Admin-exact, and it must stay that way: POST /agent/intents and
 * POST /agent/intents/:id/subintents depend on it, and the permission matrix
 * grants subintent creation to Admin only. Widening this would silently grant a
 * Team Lead that capability — add a requireWorkspaceRole(...) gate on the route
 * that needs a wider set instead.
 *
 * Kept as a named export so its two existing call sites need no edit.
 */
export const requireAdminRole = requireWorkspaceRole('admin')
