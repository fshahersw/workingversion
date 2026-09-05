# Reset password for fshaher@seegerweiss.com

Set the account password to `SW-Firas1`.

## What happens

- The existing auth account for `fshaher@seegerweiss.com` gets its password updated server-side via the admin API. No new account, no sign-up path, no email sent.
- Existing sessions stay valid; the next sign-in uses the new password.
- No app code changes — this is a one-off backend account action.

## Steps

1. Look up the user id for `fshaher@seegerweiss.com` in the auth users table.
2. Update that user's password to `SW-Firas1` using the admin auth API (service-role, server-side only).
3. Verify by performing a password sign-in against the auth endpoint and confirming a session is returned.

## Note

`SW-Firas1` is short and would fail a leaked/strength check if one is later enabled. Say the word if you'd like a stronger passphrase instead.
