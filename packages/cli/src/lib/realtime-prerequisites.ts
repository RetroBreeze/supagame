import type { SecurityCheck } from './doctor-security.ts';
export function realtimePrerequisites(): SecurityCheck[] {
  return [
    {
      id: 'live:realtime-rls',
      expression:
        "exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('realtime.messages') and relrowsecurity)",
      remedy:
        'Realtime messages/RLS is unavailable. Start the full local Supabase stack, or resolve hosted Realtime service provisioning with Supabase; do not alter service-owned tables.',
    },
    {
      id: 'live:broadcast-functions',
      expression:
        "pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null and pg_catalog.to_regprocedure('realtime.topic()') is not null",
      remedy:
        'Database Broadcast/private-channel helpers are missing. Start the full local stack or resolve hosted Realtime provisioning before deploying Live Leaderboards.',
    },
    {
      id: 'live:receive-grants',
      expression:
        "pg_catalog.has_table_privilege('authenticated',pg_catalog.to_regclass('realtime.messages'),'SELECT') and exists(select 1 from pg_catalog.pg_namespace where nspname='realtime' and pg_catalog.has_schema_privilege('authenticated',oid,'USAGE')) and pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure('realtime.topic()'),'EXECUTE')",
      remedy:
        'Authenticated private-channel receive permissions are missing. Restore supported Realtime grants through a reviewed migration; do not grant client broadcast writes.',
    },
  ].map((c) => ({ ...c, module: 'live-leaderboards' }));
}
