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
  '10540000-0000-4000-8000-000000000000'::uuid,
  'openai',
  'gpt-5.4',
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
    and model = 'gpt-5.4'
    and is_enabled = true
    and effective_from <= now()
    and (effective_to is null or effective_to > now())
);
