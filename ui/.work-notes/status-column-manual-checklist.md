# Status Column Manual Checklist

- Confirm compact mode shows short labels such as `active`, `active*`, and `maxed`.
- Hover the `Status` header and verify the whole status column expands for every visible token row.
- Hover any individual status cell and verify the whole status column expands, not just that row.
- Click the `Status` header and verify expanded mode stays pinned after moving the pointer away.
- Click the `Status` header again and verify the column returns to compact mode.
- Verify `maxed · source: backend_maxed` appears for raw backend-maxed rows.
- Verify `maxed · source: cap_exhausted` appears for active Anthropic rows excluded by cap exhaustion.
- Verify `active · excluded: rate_limited`, `active · excluded: rate_limited (escalated)`, `active · excluded: snapshot_missing`, and `active · excluded: snapshot_stale` can all render without clipping.
- Verify expired and revoked rows remain hidden from the dashboard table.
- Verify mobile and narrow desktop widths still allow horizontal scroll instead of overlapping cells.
