import type { LiveInspection } from './doctor-live.ts';
import { HostedConfiguration } from './hosted-config.ts';
import { digest } from './deployment-files.ts';
import { inspectRealtime } from './realtime-inspection.ts';
export async function inspectHostedConfiguration(
  context: LiveInspection,
): Promise<void> {
  const { report, ref } = context;
  const client = new HostedConfiguration(context.run, ref);
  try {
    try {
      const auth = await client.auth();
      for (const issue of auth.authBlockers) {
        report('remote', 'anonymous-signup', 'action required', issue);
      }
      report(
        'remote',
        'anonymous-auth',
        auth.anonymous ? 'healthy' : 'action required',
        auth.anonymous
          ? 'Hosted anonymous authentication enabled (verified).'
          : 'Run supagame deploy --project-ref <ref> to preview and authorize enabling anonymous authentication.',
      );
      if (auth.anonymous !== context.localAnonymous) {
        report(
          'remote',
          'auth-drift',
          'warning',
          'Local and hosted anonymous Auth settings differ. Local TOML is preserved; deploy manages only the hosted prerequisite.',
        );
      }
      if (context.releases.some((r) => r.module === 'live-leaderboards')) {
        report(
          'remote',
          'realtime-config',
          auth.realtimeConfig ? 'healthy' : 'cannot verify',
          auth.realtimeConfig
            ? 'Realtime configuration API is readable. Global channel settings are preserved; this is not a service health or delivery check.'
            : 'Realtime configuration was not returned. Check project Realtime/read permissions.',
        );
      }
    } catch {
      report(
        'remote',
        'anonymous-auth',
        'cannot verify',
        'Hosted Auth inspection unavailable or ambiguous. Check CLI 3.0.0/config read permissions and rerun doctor.',
      );
    }
    try {
      const secret = await client.secret();
      const equal = context.origins &&
        secret.originDigest === digest(JSON.stringify(context.origins));
      report(
        'remote',
        'origins',
        equal ? 'healthy' : context.origins ? 'action required' : 'cannot verify',
        equal
          ? `${
            context.origins!.length
          } browser origins match the hosted SG_ALLOWED_ORIGINS digest. Runtime CORS still requires a browser check.`
          : context.origins
          ? 'Run supagame deploy --project-ref <ref> --dry-run to review browser origin provisioning. Unknown existing values require ALL intended origins plus explicit --replace-origins authorization.'
          : 'Hosted origins are unmanaged and unreadable. Use supagame config origins add <origin> with all intended browser origins, then preview deployment; existing values are preserved.',
      );
    } catch {
      report(
        'remote',
        'origins',
        'cannot verify',
        'Hosted origin digest unavailable. Check Edge Function secrets read permission; no secret values are printed or inferred.',
      );
    }
    if (context.releases.some((r) => r.module === 'live-leaderboards')) {
      const realtime = await inspectRealtime(ref);
      report('remote', 'realtime-service', realtime.status, realtime.message);
      report(
        'remote',
        'realtime-delivery',
        'cannot verify',
        'Catalogs and service health do not prove private-channel delivery. Verify subscribe/reconnect during real gameplay; doctor does not create users, send broadcasts or submit scores.',
      );
    }
  } finally {
    client.remove();
  }
}
