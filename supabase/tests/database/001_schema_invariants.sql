-- pgTAP · schema invariants: RLS everywhere, least-privilege function surface
-- @trace: ST-003, FR-X-010
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Every domain table: RLS enabled AND forced (docs/07 §1 convention 4).
select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','audit') and c.relkind = 'r'
      and (not c.relrowsecurity or not c.relforcerowsecurity)),
  0, 'RLS is enabled + forced on every public/audit table');

-- Forgeable-ledger hole is closed (D-011 / finding S1-2):
select ok(not has_function_privilege('authenticated', 'app.emit_audit(text,text,uuid,jsonb)', 'execute'),
  'authenticated cannot call app.emit_audit directly');
select ok(not has_function_privilege('anon', 'app.emit_audit(text,text,uuid,jsonb)', 'execute'),
  'anon cannot call app.emit_audit directly');
select ok(not has_function_privilege('authenticated', 'app.emit_audit_system(uuid,text,text,text,uuid,jsonb)', 'execute'),
  'authenticated cannot call app.emit_audit_system');
select ok(has_function_privilege('service_role', 'app.emit_audit_system(uuid,text,text,text,uuid,jsonb)', 'execute'),
  'service_role can call app.emit_audit_system');
select ok(not has_function_privilege('authenticated', 'audit.verify_chain(uuid)', 'execute'),
  'authenticated cannot call audit.verify_chain');
select ok(not has_function_privilege('authenticated', 'app.forbid_mutation()', 'execute'),
  'authenticated cannot call app.forbid_mutation');

-- The Lane-B catalog IS callable:
select ok(has_function_privilege('authenticated', 'app.create_form(uuid,uuid,jsonb)', 'execute'),
  'authenticated can call app.create_form');
select ok(has_function_privilege('authenticated', 'app.save_draft(uuid,jsonb,uuid)', 'execute'),
  'authenticated can call app.save_draft');
select ok(has_function_privilege('authenticated', 'app.finalize_form(uuid,uuid)', 'execute'),
  'authenticated can call app.finalize_form');
select ok(has_function_privilege('authenticated', 'app.correct_form(uuid,jsonb,text)', 'execute'),
  'authenticated can call app.correct_form');
select ok(has_function_privilege('authenticated', 'app.sign_version(uuid,text)', 'execute'),
  'authenticated can call app.sign_version');

-- Transition-guard-by-privilege (D-011 / findings S1-4, S4-2, S5-3):
select ok(not has_table_privilege('authenticated', 'public.form_instance', 'insert'),
  'no direct INSERT on form_instance (RPC only)');
select ok(not has_table_privilege('authenticated', 'public.form_instance', 'update'),
  'no direct UPDATE on form_instance (status transitions RPC-only)');
select ok(not has_table_privilege('authenticated', 'public.form_version', 'insert'),
  'no direct INSERT on form_version (version_no is server-assigned)');
select ok(not has_table_privilege('authenticated', 'public.form_version', 'update'),
  'no UPDATE grant on form_version (append-only)');
select ok(not has_table_privilege('authenticated', 'public.form_version', 'delete'),
  'no DELETE grant on form_version (append-only)');
select ok(not has_table_privilege('authenticated', 'public.signature', 'insert'),
  'no direct INSERT on signature (app.sign_version only)');
select ok(not has_table_privilege('authenticated', 'audit.audit_event', 'select'),
  'no direct SELECT on audit.audit_event (definer read paths only)');

-- Constraint-true e-sign binding exists (D-011 / findings S1-5, S5-2):
select ok(exists(
  select 1 from pg_constraint
   where conname = 'fk_signature_version_hash' and contype = 'f'),
  'signature (form_version_id, content_hash) composite FK exists');

select * from finish();
rollback;
