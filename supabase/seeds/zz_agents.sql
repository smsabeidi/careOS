-- Seed · The v1 agent fleet for the synthetic Meadowbrook universe (ST-154, D-020)
-- Same single-source provisioning migration 0035 applies to hosted tenants.
select app.provision_agent_fleet(t.id) from public.tenant t;
