import { realtimePrerequisites } from "./realtime-prerequisites.ts";
import { sqlLiteral } from "./migration-generator.ts";
import type { ModuleName } from "./versions.ts";
export interface SecurityCheck {
  id: string;
  module: ModuleName;
  expression: string;
  remedy: string;
}
const tables = [
  {
    module: "core",
    schema: "public",
    name: "game_players",
    columns: ["display_name", "user_id"],
    policy: "game_players_visible_read",
    qual: "(NOT hidden)",
  },
  {
    module: "leaderboards",
    schema: "public",
    name: "game_leaderboards",
    columns: [
      "enabled",
      "id",
      "kind",
      "max_value",
      "min_value",
      "sort_direction",
    ],
    policy: "game_leaderboards_enabled_read",
    qual: "enabled",
  },
  {
    module: "leaderboards",
    schema: "public",
    name: "game_best_scores",
    columns: ["achieved_at", "leaderboard_id", "score", "user_id"],
    policy: "game_best_scores_visible_read",
    qual:
      "((EXISTS ( SELECT 1 FROM game_leaderboards board WHERE (board.id = game_best_scores.leaderboard_id))) AND (EXISTS ( SELECT 1 FROM game_players player WHERE (player.user_id = game_best_scores.user_id))))",
  },
  {
    module: "leaderboards",
    schema: "sg_private",
    name: "game_submission_events",
    columns: [],
    policy: null,
    qual: null,
  },
] as const;
export function securityChecks(
  modules: readonly ModuleName[],
): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  const add = (
    module: ModuleName,
    id: string,
    expression: string,
    remedy: string,
  ) => {
    if (modules.includes(module)) {
      checks.push({ module, id, expression, remedy });
    }
  };
  for (const t of tables) {
    const relation = sqlLiteral(`${t.schema}.${t.name}`),
      oid = `pg_catalog.to_regclass(${relation})`;
    add(
      t.module,
      `rls:${t.schema}.${t.name}`,
      `exists(select 1 from pg_catalog.pg_class where oid=${oid} and relrowsecurity and relkind='r')`,
      "Restore the required table and enabled RLS using reviewed forward-only migrations.",
    );
    const where = `schemaname=${sqlLiteral(t.schema)} and tablename=${
      sqlLiteral(t.name)
    }`;
    const qual = t.qual?.replace(/\s+/g, "");
    const expected = t.policy
      ? `pg_catalog.count(*)=1 and pg_catalog.bool_and(policyname=${
        sqlLiteral(t.policy)
      } and cmd='SELECT' and permissive='PERMISSIVE' and roles::pg_catalog.text[] @> array['anon','authenticated']::pg_catalog.text[] and pg_catalog.cardinality(roles)=2 and with_check is null and pg_catalog.replace(pg_catalog.regexp_replace(qual,'\\s+','','g'),'public.','')=${
        sqlLiteral(qual!)
      })`
      : "pg_catalog.count(*)=0";
    add(
      t.module,
      `policies:${t.schema}.${t.name}`,
      `(select ${expected} from pg_catalog.pg_policies where ${where})`,
      "RLS policy drift: compare the installed version’s policies and remove unintended access through a reviewed migration.",
    );
    for (const role of ["anon", "authenticated"]) {
      const r = sqlLiteral(role);
      add(
        t.module,
        `writes:${role}:${t.name}`,
        `exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.rolname=${r} where c.oid=${oid} and not r.rolsuper and not r.rolbypassrls and not pg_catalog.pg_has_role(r.oid,c.relowner,'MEMBER') and not pg_catalog.has_table_privilege(${r},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not pg_catalog.has_any_column_privilege(${r},c.oid,'INSERT,UPDATE,REFERENCES'))`,
        "Prohibited direct write/ownership/bypass privilege. Revoke unintended grants with a reviewed migration; never grant API roles direct writes.",
      );
      const array = t.columns.length
        ? `array[${t.columns.map(sqlLiteral).join(",")}]::pg_catalog.text[]`
        : "array[]::pg_catalog.text[]";
      add(
        t.module,
        `reads:${role}:${t.name}`,
        `(select coalesce(pg_catalog.array_agg(a.attname::pg_catalog.text order by a.attname),array[]::pg_catalog.text[]) from pg_catalog.pg_attribute a where a.attrelid=${oid} and a.attnum>0 and not a.attisdropped and pg_catalog.has_column_privilege(${r},a.attrelid,a.attnum,'SELECT'))=${array}`,
        "Column-level read grants drifted. Restore the versioned public-column allowlist; keep moderation/submission fields private.",
      );
    }
  }
  for (const role of ["anon", "authenticated"]) {
    add(
      "leaderboards",
      `private-schema:${role}`,
      `exists(select 1 from pg_catalog.pg_namespace where nspname='sg_private' and not pg_catalog.has_schema_privilege(${
        sqlLiteral(role)
      },oid,'USAGE,CREATE'))`,
      "Revoke API-role usage/create access to sg_private.",
    );
  }
  const functions = [
    ["core", "sg_get_my_profile", "", true, false],
    ["core", "sg_update_my_profile", "text", true, false],
    ["leaderboards", "sg_submit_score", "text, bigint, uuid", true, false],
    ["leaderboards", "sg_list_leaderboards", "", false, true],
    ["leaderboards", "sg_get_entries", "text, integer, jsonb", false, true],
    ["leaderboards", "sg_get_my_score", "text", false, false],
  ] as const;
  for (const [module, name, args, definer, publicRead] of functions) {
    const oid = `pg_catalog.to_regprocedure(${
      sqlLiteral(`public.${name}(${args})`)
    })`;
    add(
      module,
      `function:${name}`,
      `(select pg_catalog.count(*)=1 and pg_catalog.bool_and(p.oid=${oid} and p.prosecdef=${definer} and p.proconfig=array['search_path=""']::pg_catalog.text[]) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${
        sqlLiteral(name)
      })`,
      "Restore the expected RPC signature, security mode and empty search_path. Unexpected overloads also require review.",
    );
    add(
      module,
      `execute:${name}`,
      `pg_catalog.has_function_privilege('authenticated',${oid},'EXECUTE') and pg_catalog.has_function_privilege('anon',${oid},'EXECUTE')=${publicRead} and not pg_catalog.has_function_privilege('service_role',${oid},'EXECUTE') and not exists(select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where p.oid=${oid} and a.grantee=0 and a.privilege_type='EXECUTE')`,
      "Restore narrow RPC EXECUTE grants; PUBLIC/service_role must not acquire execution through broad grants.",
    );
  }
  add(
    "live-leaderboards",
    "live:trigger",
    `exists(select 1 from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('sg_private.live_invalidate()') and prosecdef and proconfig=array['search_path=""']::text[]) and not pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure('sg_private.live_invalidate()'),'EXECUTE') and not pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure('sg_private.live_invalidate()'),'EXECUTE') and not exists(select 1 from pg_catalog.pg_proc p, lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where p.oid=pg_catalog.to_regprocedure('sg_private.live_invalidate()') and a.grantee=0 and a.privilege_type='EXECUTE')`,
    "Restore the Live Leaderboards trigger function and restricted grants with a forward-only migration.",
  );
  add(
    "live-leaderboards",
    "live:triggers",
    `(select count(*)=4 and bool_and(t.tgenabled='O' and t.tgfoid=pg_catalog.to_regprocedure('sg_private.live_invalidate()') and t.tgrelid=pg_catalog.to_regclass(e.relation) and t.tgtype=e.kind and t.tgqual is null and t.tgnargs=0 and not t.tgisinternal) from (values ('supagame_live_scores','public.game_best_scores',29),('supagame_live_profiles','public.game_players',17),('supagame_live_player_delete','public.game_players',11),('supagame_live_boards','public.game_leaderboards',27)) e(name,relation,kind) join pg_catalog.pg_trigger t on t.tgname=e.name)`,
    "Restore all four enabled Live Leaderboards triggers.",
  );
  add(
    "live-leaderboards",
    "live:authorization",
    `exists(select 1 from pg_catalog.pg_policies where schemaname='realtime' and tablename='messages' and policyname='supagame_live_receive' and cmd='SELECT' and roles=array['authenticated']::name[] and pg_catalog.regexp_replace(qual,'\\s+','','g')=${
      sqlLiteral(
        "((extension = 'broadcast'::text) AND (EXISTS ( SELECT 1 FROM game_leaderboards b WHERE (b.enabled AND (realtime.topic() = ('supagame:leaderboard:'::text || b.id))))))"
          .replace(/\s+/g, ""),
      )
    }) and exists(select 1 from pg_catalog.pg_policies where schemaname='realtime' and tablename='messages' and policyname='supagame_live_no_client_send' and cmd='INSERT' and permissive='RESTRICTIVE' and roles @> array['anon','authenticated']::name[] and pg_catalog.cardinality(roles)=2 and with_check=${
      sqlLiteral("(realtime.topic() !~~ 'supagame:leaderboard:%'::text)")
    })`,
    "Restore private receive authorization and restrictive client-send denial. Review other Realtime policies for broad receive access.",
  );
  for (const check of realtimePrerequisites()) {
    add(check.module, check.id, check.expression, check.remedy);
  }
  add(
    "live-leaderboards",
    "live:other-policies",
    "not exists(select 1 from pg_catalog.pg_policies where schemaname='realtime' and tablename='messages' and policyname<>'supagame_live_receive' and permissive='PERMISSIVE' and cmd in ('SELECT','ALL') and roles && array['public','anon','authenticated']::name[])",
    "Additional permissive Realtime receive policies require review: they combine with OR and may allow access beyond enabled Supagame boards. Restrict their topic namespaces in a reviewed migration; Supagame preserves unrelated policies.",
  );
  for (const table of ["game_achievements", "game_player_achievements"]) {
    add(
      "achievements",
      `rls:${table}`,
      `exists(select 1 from pg_class where oid=to_regclass('public.${table}') and relrowsecurity)`,
      "Restore achievement RLS.",
    );
    for (const role of ["anon", "authenticated"]) {
      add(
        "achievements",
        `writes:${role}:${table}`,
        `not (has_table_privilege('${role}','public.${table}','INSERT') or has_any_column_privilege('${role}','public.${table}','UPDATE') or has_table_privilege('${role}','public.${table}','DELETE'))`,
        "Remove client achievement write grants.",
      );
    }
  }
  add(
    "achievements",
    "policies:achievements",
    "(select count(*)=1 and bool_and(cmd='SELECT' and roles::text[] @> array['authenticated'] and cardinality(roles)=1 and replace(replace(regexp_replace(qual,'\\s+','','g'),'public.',''),'auth.','')='(user_id=(SELECTuid()ASuid))') from pg_policies where schemaname='public' and tablename='game_player_achievements')",
    "Restore the owner-only achievement SELECT policy.",
  );
  add(
    "achievements",
    "function:achievements",
    "exists(select 1 from pg_proc where oid=to_regprocedure('public.sg_get_achievements()') and prosecdef and proconfig @> array['search_path=\"\"'])",
    "Restore the secured achievement read function.",
  );
  add(
    "achievements",
    "rpc:achievements",
    "has_function_privilege('authenticated','public.sg_get_achievements()','EXECUTE') and not has_function_privilege('anon','public.sg_get_achievements()','EXECUTE')",
    "Restore achievement RPC grants.",
  );
  add(
    "achievements",
    "trigger:achievements",
    "exists(select 1 from pg_trigger where tgname='award_score_achievements' and tgrelid='sg_private.game_submission_events'::regclass and tgenabled='O')",
    "Restore accepted-score achievement trigger.",
  );
  return checks;
}
export function securityQuery(checks: readonly SecurityCheck[]): string {
  return checks.map((c) =>
    `select ${
      sqlLiteral(c.id)
    } as check, coalesce((${c.expression}),false) as ok`
  ).join("\nunion all\n");
}
