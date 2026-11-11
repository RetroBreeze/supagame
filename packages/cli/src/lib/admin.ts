import { sqlLiteral } from "./migration-generator.ts";
export type AdminKind = "leaderboard" | "score" | "player";
export type AdminAction =
  | "leaderboard.reset"
  | "leaderboard.disable"
  | "leaderboard.enable"
  | "score.hide"
  | "score.restore"
  | "player.restrict"
  | "player.reinstate";
export interface AdminOperation {
  action: AdminAction;
  target: string;
  revision: number;
  operationId: string;
  reason: string;
}
export function adminMutation(input: AdminOperation): string {
  if (
    !Number.isSafeInteger(input.revision) || input.revision < 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.operationId,
    ) || !input.reason.trim() || input.reason.length > 1000
  ) {
    throw new Error(
      "Require a valid operation UUID, nonnegative revision and reason (1–1000 characters).",
    );
  }
  return `select sg_private.admin_apply(${sqlLiteral(input.action)},${
    sqlLiteral(input.target)
  },${input.revision},${sqlLiteral(input.operationId)}::uuid,${
    sqlLiteral(input.reason)
  }) as result`;
}
export function adminInspection(
  kind: AdminKind,
  target: string,
  generation?: number,
): string {
  if (
    generation !== undefined &&
    (!Number.isSafeInteger(generation) || generation < 1)
  ) throw new Error("Generation must be a positive integer.");
  const id = sqlLiteral(target);
  if (kind === "leaderboard") {
    return `select to_jsonb(b) || jsonb_build_object('revision',b.admin_revision,'activePlayers',(select count(*) from public.game_best_scores where leaderboard_id=b.id),'generations',(select coalesce(jsonb_agg(g),'[]') from (select generation,count(*) as submissions from sg_private.game_submission_events where leaderboard_id=b.id group by generation order by generation) g),'recentSubmissions',(select coalesce(jsonb_agg(e),'[]') from (select id,generation,submitted_score,hidden,created_at from sg_private.game_submission_events where leaderboard_id=b.id ${
      generation === undefined ? "" : `and generation=${generation}`
    } order by created_at desc limit 100)e),'lastModification',(select to_jsonb(a) - 'request' from sg_private.admin_audit a where target=b.id and target_type='leaderboard' order by created_at desc limit 1)) as result from public.game_leaderboards b where id=${id}`;
  }
  if (kind === "score") {
    return `select to_jsonb(e) || jsonb_build_object('revision',admin_revision) as result from sg_private.game_submission_events e where id=${id}::uuid`;
  }
  return `select jsonb_build_object('user_id',u.id,'revision',coalesce(r.revision,0),'restricted',coalesce(r.restricted,false),'reason',r.reason,'profile',(select to_jsonb(p) from public.game_players p where p.user_id=u.id),'history',(select coalesce(jsonb_agg(a),'[]') from (select action,reason,created_at from sg_private.admin_audit where target=${id} and target_type='player' order by created_at desc limit 50)a)) as result from auth.users u left join sg_private.admin_restrictions r on r.user_id=u.id where u.id=${id}::uuid`;
}
export const adminDoctorSql =
  `select 'admin' as module, to_regprocedure('sg_private.admin_apply(text,text,bigint,uuid,text)') is not null as installed, not has_function_privilege('anon','sg_private.admin_apply(text,text,bigint,uuid,text)','execute') and not has_function_privilege('authenticated','sg_private.admin_apply(text,text,bigint,uuid,text)','execute') and not has_function_privilege('service_role','sg_private.admin_apply(text,text,bigint,uuid,text)','execute') as restricted_execution, (select bool_and(relrowsecurity) from pg_class where oid in ('sg_private.admin_permissions'::regclass,'sg_private.admin_restrictions'::regclass,'sg_private.admin_audit'::regclass)) as rls,
 exists(select 1 from supabase_migrations.schema_migrations where version='20261111000100') as migration_applied,
 (select bool_and(p.proconfig @> array['search_path=""']::text[] and not has_function_privilege(r,p.oid,'execute')) from pg_proc p cross join (values('anon'),('authenticated'),('service_role')) roles(r) where p.pronamespace='sg_private'::regnamespace and p.proname in ('admin_apply','admin_project_score','admin_has_permission')) as private_functions,
 (select bool_and(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) from (values('anon'),('authenticated'),('service_role')) roles(r) cross join (values('sg_private.admin_permissions'),('sg_private.admin_restrictions'),('sg_private.admin_audit')) tables(t)) as private_tables`;
