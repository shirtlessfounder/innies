# Innies Beta Decisions

Use this page as the short version of how Innies works right now.

## Accounts And Orgs

- You can create multiple orgs.
- You can join multiple orgs.
- Every org lives at its own route.
- The org URL slug is auto-generated from the org name and is not editable in beta.
- Accept invites from the org route you were invited to by navigating to the org's Innies link.
- To accept an invite, you need to be signed into the same GitHub account that was invited.
- You can switch orgs by clicking the org links in the header.
- Each org has one owner in this beta.
- The owner cannot leave the org in beta.

## Buyer Keys

- Each org membership gets its own buyer key.
- Buyer keys are org-specific. One key does not unlock every org you belong to.
- After you create an org or accept an invite, the new buyer key is shown once.
- If you lose that key, contact Innies support or the admin for now.

## Roles And Permissions

- Owners can manage invites and members.
- Owners can probe, change reserve caps, and remove any OAuth token in the org.
- Owners can refresh any OAuth token in the org.
- Members can manage only the OAuth tokens they personally added.
- Members can refresh only the OAuth tokens they personally added.
- Users can remove the OAuth tokens they personally added to an org at any time.

## OAuth Tokens

- OAuth tokens are added to a specific org.
- These are Claude/Codex OAuth tokens, not raw provider API keys.
- Adding an OAuth token requires both the OAuth token and the refresh token.
- One OAuth token can belong to only one org at a time.
- That org can route through the OAuth tokens that belong to it.

## Reserves

- Reserves are the 5h and 1w percentages that keep some token capacity buffered instead of fully routing it.
- Reserve inputs are percentages from 0 to 100.
- You can set reserves when adding an OAuth token to an org.
- Leaving reserve inputs blank means no reserve buffer.

## Leaving Or Removal

- If you leave an org or are removed, your buyer key for that org is revoked.
- If you leave an org or are removed, the OAuth tokens you added to that org are removed too.

## Beta Limits

- Some recovery flows are still manual.
- Ownership transfer is not part of this beta.
- The product is intentionally simple while the org model hardens.
