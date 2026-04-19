-- Enable Anthropic Claude Opus 4.7 (model id `claude-opus-4-7`, GA 2026-04-16).
-- Follows the same shape as 029_openai_model_gpt_5_4_mini.sql — guarded INSERT
-- that no-ops if an active rule for this (provider, model) already exists.
-- Streaming + tools: same as opus 4.6.
-- max_input_tokens / max_output_tokens: left null, matching the rest of the
-- anthropic + openai rows (the model's own 1M context / 128k output caps are
-- enforced upstream; nothing in this table gates them).

insert into in_model_compatibility_rules (
  id,
  provider,
  model,
  supports_streaming,
  supports_tools,
  max_input_tokens,
  max_output_tokens,
  is_enabled,
  effective_from
)
select
  '10570001-0000-4000-8000-000000000000'::uuid,
  'anthropic',
  'claude-opus-4-7',
  true,
  true,
  null,
  null,
  true,
  now()
where not exists (
  select 1
  from in_model_compatibility_rules
  where provider = 'anthropic'
    and model = 'claude-opus-4-7'
    and is_enabled = true
    and effective_from <= now()
    and (effective_to is null or effective_to > now())
);

-- No niyant grant changes: seeds compatibility data only.
