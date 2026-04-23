-- Enable OpenAI GPT-5.5 (model id `gpt-5.5`, GA 2026-04-23).
-- Follows the same shape as 035_anthropic_model_claude_opus_4_7_no_extensions.sql
-- — guarded INSERT that no-ops if an active rule for this (provider, model)
-- already exists.
-- Streaming + tools: same as gpt-5.4.
-- max_input_tokens / max_output_tokens: left null, matching the rest of the
-- anthropic + openai rows (the model's own context / output caps are enforced
-- upstream; nothing in this table gates them).

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
  '10550000-0000-4000-8000-000000000000'::uuid,
  'openai',
  'gpt-5.5',
  true,
  true,
  null,
  null,
  true,
  now()
where not exists (
  select 1
  from in_model_compatibility_rules
  where provider = 'openai'
    and model = 'gpt-5.5'
    and is_enabled = true
    and effective_from <= now()
    and (effective_to is null or effective_to > now())
);

-- No niyant grant changes: seeds compatibility data only.
