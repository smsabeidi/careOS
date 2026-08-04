-- Seed · Employee rows for the synthetic Meadowbrook universe (ST-131)
-- Runs after meadowbrook_universe.sql (seeds apply alphabetically), deriving an
-- employee record for every kind='staff' app_user via the same reusable backfill the
-- 0028 migration uses on populated databases — one mapping, two entry points.
select app.backfill_employees();
