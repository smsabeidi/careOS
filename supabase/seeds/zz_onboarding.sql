-- Seed · Onboarding catalog for the synthetic Meadowbrook universe (ST-136)
-- Same single-source content as migration 0033 applies to hosted tenants.
select app.seed_onboarding_catalog(t.id) from public.tenant t;
