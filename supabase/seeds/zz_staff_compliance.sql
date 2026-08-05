-- Seed · Staff-compliance catalog + cadence for the synthetic Meadowbrook universe
-- (ST-170/171). Same single-source functions migration 0038 applies to hosted tenants;
-- one evaluation pass materializes the demo obligations the UI shows.
select app.expand_credential_catalog(t.id) from public.tenant t;
select app.seed_staff_cadence(t.id) from public.tenant t;
select app.evaluate_staff_compliance();
