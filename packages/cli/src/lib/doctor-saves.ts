import type { SecurityCheck } from "./doctor-security.ts";
import { sqlLiteral } from "./migration-generator.ts";
export function saveSecurityChecks(): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  const add = (
    id: string,
    expression: string,
    remedy = "Restore Cloud Saves with a reviewed additive migration; do not grant client writes.",
  ) => checks.push({ module: "cloud-saves", id, expression, remedy });
  add(
    "saves:bucket",
    "exists(select 1 from storage.buckets b,sg_private.save_config c where b.id='supagame-saves' and b.name=b.id and not b.public and b.file_size_limit=c.max_binary_bytes)",
  );
  for (const table of [
    "public.game_saves",
    "sg_private.save_config",
    "sg_private.save_objects",
    "sg_private.save_operations",
    "sg_private.save_revisions",
    "sg_private.save_state",
  ]) {
    add(
      `saves:rls:${table}`,
      `exists(select 1 from pg_class where oid=to_regclass('${table}') and relrowsecurity)`,
    );
    for (const role of ["anon", "authenticated"])
      add(
        `saves:writes:${role}:${table}`,
        `not has_table_privilege('${role}','${table}','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_any_column_privilege('${role}','${table}','INSERT,UPDATE,REFERENCES')`,
      );
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    add(
      `saves:recovery-private:${role}`,
      `not has_table_privilege('${role}','sg_private.save_revisions','SELECT') and not has_function_privilege('${role}','sg_private.prune_save_revisions(uuid)','EXECUTE')`,
    );
  }
  add(
    "saves:owner-policy",
    "(select count(*)=1 and bool_and(cmd='SELECT' and roles=array['authenticated']::name[] and replace(replace(regexp_replace(qual,'\\s+','','g'),'public.',''),'auth.','')='(user_id=(SELECTuid()ASuid))') from pg_policies where schemaname='public' and tablename='game_saves' and permissive='PERMISSIVE')",
  );
  add(
    "saves:active-identity-policy",
    "exists(select 1 from pg_policies where schemaname='public' and tablename='game_saves' and policyname='supagame_saves_active_identity' and permissive='RESTRICTIVE' and cmd='SELECT' and roles=array['authenticated']::name[] and replace(regexp_replace(qual,'\\s+','','g'),'public.','')='(SELECTsg_save_identity_active()ASsg_save_identity_active)')",
  );
  for (const role of ["anon", "authenticated", "service_role"]) {
    add(`saves:private-helpers:${role}`,
      ["lock_save_identity()", "advance_save_generation(uuid)", "maintain_save_history(uuid)", "consume_save_rate(uuid,text)", "order_save_receipt()"]
        .map(fn => `not has_function_privilege('${role}','sg_private.${fn}','EXECUTE')`).join(" and ")
      + ` and not has_table_privilege('${role}','sg_private.save_state','SELECT')`);
  }
  const policies = [
    ["read", "SELECT", "qual"],
    ["insert", "INSERT", "with_check"],
    ["delete", "DELETE", "qual"],
  ] as const;
  const clauses = policies.map(
    ([action, cmd, column]) =>
      `exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='supagame_saves_${action}_guard' and permissive='RESTRICTIVE' and cmd='${cmd}' and roles @> array['anon','authenticated']::name[] and cardinality(roles)=2 and replace(regexp_replace(${column},'\\s+','','g'),'public.','')=${sqlLiteral(`((bucket_id<>'supagame-saves'::text)ORsg_save_object_access(name,'${action}'::text))`)})`,
  );
  clauses.push(
    "exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='supagame_saves_update_guard' and permissive='RESTRICTIVE' and cmd='UPDATE' and roles @> array['anon','authenticated']::name[] and cardinality(roles)=2 and regexp_replace(qual,'\\s+','','g')='(bucket_id<>''supagame-saves''::text)' and qual=with_check)",
  );
  add("saves:storage-guards", clauses.join(" and "));
  for (const [name, args, anon] of [
    ["sg_cloud_save", "text,text,jsonb", false],
    ["sg_save_object_access", "text,text", true],
    ["sg_save_upload_size", "text,text", true],
    ["sg_save_identity_active", "", false],
  ] as const) {
    add(
      `saves:rpc:${name}`,
      `exists(select 1 from pg_proc where oid=to_regprocedure('public.${name}(${args})') and prosecdef and proconfig=array['search_path=""']::text[]) and has_function_privilege('authenticated','public.${name}(${args})','EXECUTE') and has_function_privilege('anon','public.${name}(${args})','EXECUTE')=${anon} and not has_function_privilege('service_role','public.${name}(${args})','EXECUTE') and not exists(select 1 from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure('public.${name}(${args})') and a.grantee=0 and a.privilege_type='EXECUTE')`,
    );
  }
  add(
    "saves:upload-quota",
    "exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='supagame_saves_size_guard' and permissive='RESTRICTIVE' and cmd='INSERT' and roles @> array['anon','authenticated']::name[] and replace(regexp_replace(with_check,'\\s+','','g'),'public.','')='((bucket_id<>''supagame-saves''::text)ORsg_save_upload_size(name,COALESCE((metadata->>''size''::text),(metadata->>''contentLength''::text))))')",
  );
  add(
    "saves:orphan-objects",
    "not exists(select 1 from sg_private.save_objects o where not exists(select 1 from auth.users u where u.id=o.user_id))",
    "Deleted Auth users have retained object records. Use the documented operator cleanup tool; never delete Storage metadata directly.",
  );
  return checks;
}
