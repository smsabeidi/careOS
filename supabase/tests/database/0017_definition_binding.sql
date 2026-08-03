-- pgTAP · 0012 — form definitions are immutable and records are bound to them (D-014)
-- Mirrors the D-011 e-sign proof style in 001/003: assert the constraint EXISTS, then
-- prove it BITES by attempting the violation and catching the SQLSTATE.
-- @trace: ST-111, D-014
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ── Structure ──────────────────────────────────────────────────────────────
select has_column('public', 'form_template', 'schema_hash',
  'form_template carries schema_hash');
select col_not_null('public', 'form_template', 'schema_hash',
  'schema_hash is NOT NULL — every definition is content-addressed');
select has_column('public', 'form_version', 'template_id',
  'form_version records the definition it was authored under');
select has_column('public', 'form_version', 'template_schema_hash',
  'form_version records the definition CONTENT it was authored under');

select isnt_empty(
  $$ select 1 from pg_constraint
      where conname = 'form_template_id_schema_hash_key' and contype = 'u' $$,
  'form_template has unique(id, schema_hash) — the composite-FK target');
select isnt_empty(
  $$ select 1 from pg_constraint
      where conname = 'fk_form_version_template_schema' and contype = 'f' $$,
  'form_version->form_template binding is a real FOREIGN KEY, not a comment');
select isnt_empty(
  $$ select 1 from pg_trigger
      where tgname = 'trg_form_template_ao'
        and tgrelid = 'public.form_template'::regclass $$,
  'form_template carries the append-only trigger');

-- ── The hash actually matches the schema (not merely present) ──────────────
select is_empty(
  $$ select id from public.form_template
      where schema_hash
            is distinct from extensions.digest(convert_to(schema::text,'utf8'),'sha256') $$,
  'every seeded template schema_hash equals sha256 of its schema');

-- ── Backfill covered every pre-existing version row ────────────────────────
select is_empty(
  $$ select fv.id from public.form_version fv where fv.template_id is null $$,
  '0012 backfill bound every pre-existing form_version to its template');

select is_empty(
  $$ select fv.id
       from public.form_version fv
       join public.form_instance fi on fi.id = fv.instance_id
      where fv.template_id is distinct from fi.template_id $$,
  'each version binds to the SAME template its instance pins');

-- ── The append-only guarantee bites ────────────────────────────────────────
-- This is the whole point of the migration: before 0017 this UPDATE succeeded, and
-- succeeding meant a signed 2026 record silently changed what it appeared to say.
select throws_ok(
  $$ update public.form_template
        set schema = '{"fields":[]}'::jsonb
      where key = 'rn_assessment' $$,
  'P0001',
  NULL,
  'UPDATE on form_template is refused — a published definition cannot be edited in place');

select throws_ok(
  $$ delete from public.form_template where key = 'rn_assessment' $$,
  'P0001',
  NULL,
  'DELETE on form_template is refused');

-- ── The binding is constraint-true, not convention-true ────────────────────
-- Claiming a definition whose content hash does not match must fail at the FK layer
-- (23503), exactly as a forged signature content_hash does under D-011.
select throws_ok(
  $$ insert into public.form_version
       (tenant_id, instance_id, version_no, content, content_hash, author_id, kind,
        template_id, template_schema_hash)
     select fi.tenant_id, fi.id, 9001, '{}'::jsonb,
            extensions.digest(convert_to('{}','utf8'),'sha256'),
            fi.created_by, 'edit',
            fi.template_id, extensions.digest(convert_to('forged','utf8'),'sha256')
       from public.form_instance fi limit 1 $$,
  '23503',
  NULL,
  'a form_version claiming a schema_hash that is not the template''s is rejected by the FK');

-- ── Half a binding is not a binding ────────────────────────────────────────
select throws_ok(
  $$ insert into public.form_version
       (tenant_id, instance_id, version_no, content, content_hash, author_id, kind,
        template_id, template_schema_hash)
     select fi.tenant_id, fi.id, 9002, '{}'::jsonb,
            extensions.digest(convert_to('{}','utf8'),'sha256'),
            fi.created_by, 'edit', fi.template_id, NULL
       from public.form_instance fi limit 1 $$,
  '23514',
  NULL,
  'a partially-populated binding is rejected by form_version_binding_complete');

-- ── New templates get hashed automatically ─────────────────────────────────
insert into public.form_template (tenant_id, key, title, schema)
select id, 'zz_pgtap_probe', 'pgTAP probe', '{"fields":[{"key":"a","label":"A","type":"text"}]}'::jsonb
  from public.tenant limit 1;

select is_empty(
  $$ select 1 from public.form_template
      where key = 'zz_pgtap_probe'
        and schema_hash
            is distinct from extensions.digest(convert_to(schema::text,'utf8'),'sha256') $$,
  'the BEFORE INSERT trigger stamps schema_hash on newly authored templates');

select finish();
rollback;
