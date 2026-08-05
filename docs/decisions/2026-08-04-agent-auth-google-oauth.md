# Agent authentication is Google OAuth 2, restricted to the mindstormstudios.com org

**Date:** 2026-08-04
**Status:** Accepted
**Supersedes:** the `password_hash` column on `agent` in `docs/specs/2026-08-04-database-and-schema-design.md`
**Context:** surfaced by the repo owner during the SDK-seam slice, while reviewing which database role may write the unscoped tables

## Decision

Agents, Team Leads and Admins sign in to the console with **Google OAuth 2**. The server verifies
the Google ID token **and** that the account belongs to the **`mindstormstudios.com`** Google
organisation. **There are no passwords in the product.**

`agent` therefore holds a Google identity, not a credential:

| Column | Purpose |
|---|---|
| `email` (citext, unique) | The Google account address. Case-insensitive because Google addresses are. |
| `google_subject` (text, unique, nullable) | The Google `sub` claim — the stable per-account identifier. Nullable only until a seeded row's first real login. |
| `display_name` | From the Google profile, refreshed on login. |
| `status` | `active` / `on_leave` / `deactivated`, unchanged. |

`password_hash` is **removed**. It never held a password and would have been a permanent trap: the
seed wrote the literal string `set-me-when-agent-auth-ships` into a `NOT NULL` column.

## Why the domain check is separate from the OAuth check

OAuth proves *who* someone is. It does not prove *where they work*. Any Google account can complete
an OAuth flow against our client id, so without an explicit organisation check, `anyone@gmail.com`
would authenticate successfully and — depending on the handler — could be upserted as an agent.

The check must be **server-side, on every login**, against the token's verified domain claim. It must
not be:

- a client-side filter (trivially bypassed — the browser is not a trust boundary),
- the `hd` parameter on the authorisation request (a *hint* to Google's account chooser, not an
  enforcement; the returned token still needs verifying),
- inferred from the email string's suffix alone, without validating the token's issuer and audience
  first.

## Consequences for tenancy

The console's first-login flow **upserts an `agent` row**, which makes it a request-path write to an
unscoped table. So the application database role (`support_app`) **must retain INSERT and UPDATE on
`agent`**, and cannot be locked down the way `workspace` can — see
[`2026-08-04-unscoped-table-writes.md`](2026-08-04-unscoped-table-writes.md). When the console ships,
narrow it to column-scoped grants (`GRANT UPDATE (display_name, status, google_subject) ON agent`)
rather than table-wide UPDATE.

`agent` remains one of only two unscoped tables: one login per person, with the **role held per
workspace** in `workspace_member`. A person on three games has one Google identity and three
`workspace_member` rows. OAuth changes the credential, not that structure.

Short-TTL session JWT plus a Redis denylist — from the schema spec — still stands, and matters more
under OAuth than it did under passwords: deactivating someone has to take effect immediately, and we
cannot revoke a Google account.

## Scope

**Not built in the SDK-seam slice.** That slice ends at the player-facing seam; the console is a
later slice. What lands now is only the schema correction, so no code is written against a column
that was never going to hold a password. The OAuth flow itself — client registration, the callback
route, token verification, the domain check, session issuance and the denylist — belongs to the
console slice and needs its own plan.

## Rejected

**Keeping `password_hash` "just in case" as a fallback login.** A password fallback would defeat the
point: the organisation restriction is the access control, and a password path around it is a way in
for an account Google would have refused. It would also mean storing credentials, which this
decision removes entirely.
