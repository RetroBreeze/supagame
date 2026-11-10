import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { query, session, waitUntil } from "./local-sessions.ts";
test("concurrent accepted scores and replay persist each unlock exactly once", {
  timeout: 30000,
}, async () => {
  const user = randomUUID(), board = `ach-${randomUUID()}`, key = randomUUID();
  query(
    `insert into auth.users(id,is_anonymous) values('${user}',true); insert into public.game_leaderboards(id,kind,sort_direction) values('${board}','points','desc'); insert into public.game_achievements(id,title,description,condition_type,leaderboard_id,threshold) select '${board}-'||n,'Coins','Run','score_threshold','${board}',n from unnest(array[500,1000,5000,10000,15000,20000]) n;`,
  );
  const auth =
    `begin; set local role authenticated; set local request.jwt.claims='{"sub":"${user}"}';`;
  const first = session(
    `${auth} select public.sg_submit_score('${board}',12000,'${key}');\n\\echo READY\n`,
  );
  let second: ReturnType<typeof session> | undefined;
  try {
    await waitUntil(
      () => first.state.stdout.includes("READY"),
      "first awards before commit",
    );
    second = session(
      `${auth} select public.sg_submit_score('${board}',20000,gen_random_uuid()); commit;`,
    );
    second.child.stdin.end();
    first.child.stdin.end("commit;");
    await Promise.all([first.finished, second.finished]);
    query(
      `${auth} select public.sg_submit_score('${board}',12000,'${key}'); commit;`,
    );
    assert.equal(
      query(
        `select count(*) from public.game_player_achievements where user_id='${user}'`,
      ),
      "6",
    );
    assert.equal(
      query(
        `select count(distinct unlocked_at) from public.game_player_achievements where user_id='${user}' and achievement_id in ('${board}-500','${board}-1000','${board}-5000','${board}-10000')`,
      ),
      "1",
    );
  } finally {
    if (!first.child.stdin.writableEnded) first.child.stdin.end("rollback;");
    await Promise.allSettled([
      first.finished,
      ...(second ? [second.finished] : []),
    ]);
    query(
      `delete from auth.users where id='${user}'; delete from public.game_achievements where leaderboard_id='${board}'; delete from public.game_leaderboards where id='${board}';`,
    );
  }
});
