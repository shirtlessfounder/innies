# Truthful Token Status Column Design

## Goal

Make the analytics dashboard status column truthful about backend token state while still showing why a token is currently excluded from routing.

## Problem

The current dashboard status path rewrites backend token state into a smaller set of effective statuses. That obscures the real lifecycle state of a token and makes it hard to debug cases where:

- a token appears `maxed` but is excluded for a different reason
- a token appears `active` but is being skipped by routing

The status column needs to preserve true backend visibility without becoming too wide or noisy.

## Scope

In scope:

- analytics dashboard token status semantics
- analytics API/UI normalization for dashboard token rows
- status column presentation and interaction in the dashboard table
- test coverage for the new status mapping and UI interaction

Out of scope:

- changes to backend routing logic
- changes to token eligibility logic
- changes to expired/revoked visibility
- changes to non-dashboard pages

## User-Facing Requirements

- Keep hiding `expired` and `revoked` rows from the dashboard table.
- Preserve true backend lifecycle state for visible rows.
- Continue treating cap exhaustion as `maxed`.
- Distinguish backend-`maxed` from cap-exhausted `maxed` in expanded status text.
- Show why a raw `active` token is excluded when it is being skipped.
- Keep the default status column narrow.
- Let the user expand status detail for the whole column at once.

## Definitions

### Raw Backend Status

The persisted token credential status from the backend:

- `active`
- `paused`
- `rotating`
- `maxed`
- `expired`
- `revoked`

### Routing Exclusion Reason

The reason a raw `active` token is currently excluded from routing, when applicable. For this feature the operator-facing set is:

- `rate_limited`
- `rate_limited (escalated)`
- `snapshot_missing`
- `snapshot_stale`

### Maxed Source

When the displayed status is `maxed`, the expanded text must show whether that status came from:

- `backend_maxed`
- `cap_exhausted`

## Status Semantics

The dashboard status column becomes lifecycle-first, not availability-first.

Visible status rules:

1. `expired` and `revoked` rows remain hidden.
2. Raw `paused` displays as `paused`.
3. Raw `rotating` displays as `rotating`.
4. Raw `maxed` displays as `maxed`.
5. Raw `active` plus cap exhaustion displays as `maxed`.
6. Raw `active` plus other exclusion reasons stays `active`, but marked as excluded.
7. Raw `active` with no exclusion remains `active`.

This yields the following compact statuses:

- `active`
- `active*`
- `paused`
- `rotating`
- `maxed`

And the following expanded statuses:

- `active`
- `active · excluded: rate_limited`
- `active · excluded: rate_limited (escalated)`
- `active · excluded: snapshot_missing`
- `active · excluded: snapshot_stale`
- `paused`
- `rotating`
- `maxed · source: backend_maxed`
- `maxed · source: cap_exhausted`

## Why Cap Exhaustion Maps To Maxed

For this dashboard, `maxed` means "cannot use this token until provider-set refresh/reset time." Claude contribution-cap exhaustion fits that definition and should remain visually `maxed`.

What changes is not the compact label. What changes is the expanded text, which must reveal whether the token is:

- raw backend `maxed`
- currently `maxed` because provider cap is exhausted

## Interaction Design

### Default State

The status column stays compact:

- `active`
- `active*`
- `paused`
- `rotating`
- `maxed`

`active*` means the token is raw `active` but is currently excluded from routing for a non-cap-exhaustion reason.

### Expanded State

The entire status column expands together.

Triggers:

- hover the `Status` header
- hover any status cell in the column
- click the `Status` header to pin expanded mode on or off

Expanded mode shows the explicit text for every visible row in the column at once.

### Interaction Rules

- Hover expansion is temporary.
- Click on the header pins expansion until clicked again.
- If expanded mode is pinned, moving the cursor away does not collapse the column.
- If expanded mode is not pinned, leaving the status column collapses it.

## Data Flow Design

### Backend As Source Of Truth

This must not be implemented as a UI-only patch.

The current analytics flow already rewrites status in both backend and UI-adjacent layers. A UI-only fix would continue to rely on lossy state. The dashboard analytics payload should become the source of truth for status semantics.

Each token row returned for the dashboard should include:

- `rawStatus`
- `compactStatus`
- `expandedStatus`
- `statusSource`
- `exclusionReason`

### Derived Fields

#### `rawStatus`

The true backend lifecycle state for the token row.

#### `compactStatus`

One of:

- `active`
- `active*`
- `paused`
- `rotating`
- `maxed`

#### `expandedStatus`

The full operator-facing string rendered when the status column is expanded.

#### `statusSource`

Used when compact status is `maxed`:

- `backend_maxed`
- `cap_exhausted`
- `null` for all other statuses

#### `exclusionReason`

Used when compact status is `active*`:

- `rate_limited`
- `rate_limited_escalated`
- `snapshot_missing`
- `snapshot_stale`
- `null` otherwise

## Mapping Rules

Apply the following priority order when deriving display status:

1. Hide rows with raw `expired` or `revoked`.
2. If raw status is `paused`, return:
   - `compactStatus = paused`
   - `expandedStatus = paused`
3. If raw status is `rotating`, return:
   - `compactStatus = rotating`
   - `expandedStatus = rotating`
4. If raw status is `maxed`, return:
   - `compactStatus = maxed`
   - `expandedStatus = maxed · source: backend_maxed`
   - `statusSource = backend_maxed`
5. If raw status is `active` and cap exhaustion is active, return:
   - `compactStatus = maxed`
   - `expandedStatus = maxed · source: cap_exhausted`
   - `statusSource = cap_exhausted`
6. If raw status is `active` and repeated 429 escalation is active, return:
   - `compactStatus = active*`
   - `expandedStatus = active · excluded: rate_limited (escalated)`
   - `exclusionReason = rate_limited_escalated`
7. If raw status is `active` and ordinary cooldown is active, return:
   - `compactStatus = active*`
   - `expandedStatus = active · excluded: rate_limited`
   - `exclusionReason = rate_limited`
8. If raw status is `active` and provider usage snapshot is missing, return:
   - `compactStatus = active*`
   - `expandedStatus = active · excluded: snapshot_missing`
   - `exclusionReason = snapshot_missing`
9. If raw status is `active` and provider usage snapshot is stale in a way that excludes routing, return:
   - `compactStatus = active*`
   - `expandedStatus = active · excluded: snapshot_stale`
   - `exclusionReason = snapshot_stale`
10. Otherwise return:
   - `compactStatus = active`
   - `expandedStatus = active`

## Backend Integration Points

The implementation should centralize status derivation instead of leaving separate rewrite logic in multiple layers.

Relevant current code paths:

- backend dashboard status derivation in `/Users/dylanvu/innies/api/src/routes/analytics.ts`
- UI-adjacent fallback derivation in `/Users/dylanvu/innies/ui/src/lib/analytics/server.ts`
- Claude availability/exclusion logic in `/Users/dylanvu/innies/api/src/services/claudeCredentialAvailability.ts`
- routing-side eligibility and repeated-429 logic in `/Users/dylanvu/innies/api/src/routes/proxy.ts`

Implementation direction:

- create one shared dashboard-status derivation path on the backend
- make the dashboard payload expose the explicit derived fields
- remove duplicated status reinterpretation from the UI server adapter

## UI Integration Points

The UI should only be responsible for:

- rendering compact vs expanded status text
- managing hover-based expansion
- managing click-to-pin expansion
- sizing the status column for compact and expanded modes

The UI should not invent additional status semantics once the normalized dashboard payload is available.

## Error Handling And Edge Cases

- Unknown raw statuses should render a safe fallback compact label and expanded string rather than crashing.
- Rows missing optional provider-usage fields should still render using whatever status information is available.
- If expanded mode cannot derive a friendly exclusion reason, use a generic fallback string rather than hiding the exclusion entirely.
- Pinned expanded mode must survive polling refreshes and window changes unless the page state is explicitly reset.

## Testing

### Backend Tests

Add coverage for dashboard status derivation:

- raw `maxed` -> `maxed · source: backend_maxed`
- raw `active` + cap exhaustion -> `maxed · source: cap_exhausted`
- raw `active` + cooldown -> `active · excluded: rate_limited`
- raw `active` + repeated-429 escalation -> `active · excluded: rate_limited (escalated)`
- raw `active` + missing snapshot -> `active · excluded: snapshot_missing`
- raw `active` + stale snapshot -> `active · excluded: snapshot_stale`
- `expired` / `revoked` remain hidden from the dashboard table set

### UI Tests

Add logic or component coverage for:

- compact status rendering
- full-column expansion on header hover
- full-column expansion on cell hover
- click-to-pin expanded mode
- collapse on mouse leave when not pinned
- persistence of pinned mode across data refreshes

### Manual Verification

Verify at least these operator scenarios:

- a suspicious `maxed` row reveals whether it is `backend_maxed` or `cap_exhausted`
- an apparently healthy raw `active` token that is skipped by routing renders as `active*`
- expanded mode reveals the exclusion reason for every visible row at once
- the default table width remains acceptable in compact mode

## Non-Goals

- No changes to token eligibility logic.
- No changes to routing decisions or provider selection.
- No changes to hidden-row policy for `expired` and `revoked`.
- No redesign of the rest of the analytics table layout beyond what is necessary for the expandable status column.
