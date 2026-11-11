import { randomUUID } from "node:crypto";
import {
  type AdminAction,
  adminInspection,
  type AdminKind,
  type AdminOperation,
} from "../lib/admin.ts";
import { AdminFailure, type AdminService } from "../lib/admin-service.ts";
import { object } from "../lib/manifest.ts";
import { sqlLiteral as literal } from "../lib/migration-generator.ts";
export const actions = [
  "leaderboard.reset",
  "leaderboard.disable",
  "leaderboard.enable",
  "score.hide",
  "score.restore",
  "player.restrict",
  "player.reinstate",
] as const;
export function fields(
  value: unknown,
  allowed: string[],
): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k))) {
    throw new AdminFailure("INVALID_REQUEST", "Unexpected request fields.");
  }
  return value;
}
function text(value: unknown, max = 100): string {
  if (
    typeof value !== "string" || value.length > max || !value.length ||
    value.includes("\0")
  ) throw new AdminFailure("INVALID_REQUEST", "Invalid text value.");
  return value;
}
function uuid(value: unknown): string {
  const id = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) throw new AdminFailure("INVALID_REQUEST", "Use a complete UUID.");
  return id;
}
function board(value: unknown): string {
  const id = text(value, 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new AdminFailure("INVALID_REQUEST", "Invalid leaderboard ID.");
  }
  return id;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(object)) {
    throw new AdminFailure(
      "READ_FAILED",
      "Unsupported database response.",
      503,
    );
  }
  return value;
}
export function targetFor(action: string, value: unknown): string {
  return action.startsWith("leaderboard.") ? board(value) : uuid(value);
}
export async function readView(
  service: AdminService,
  input: unknown,
): Promise<unknown> {
  const data = fields(input, [
    "view",
    "target",
    "board",
    "search",
    "generation",
    "cursor",
  ]);
  const view = text(data.view);
  const allowed: Record<string, string[]> = {
    overview: [],
    boards: [],
    leaderboard: ["target", "generation"],
    player: ["target"],
    score: ["target"],
    scores: ["board", "search", "generation", "cursor"],
    players: ["search"],
    audit: [],
  };
  if (!Object.hasOwn(allowed, view)) {
    throw new AdminFailure("INVALID_REQUEST", "Unknown view.");
  }
  fields(data, ["view", ...allowed[view]!]);
  if (view === "overview") {
    const counts = rows(
      await service.query(
        "select (select count(*) from public.game_leaderboards) as leaderboards, (select count(*) from public.game_players) as players",
      ),
    )[0];
    return {
      project: {
        name: service.target.name,
        ref: service.target.ref,
        environment: service.target.environment,
        modules: service.target.modules,
      },
      counts,
      activity: await readView(service, { view: "audit" }),
      security: "Startup security and operator checks passed",
      warnings: [
        "Operator attribution is the database role, not a unique human identity.",
        "Anonymous restrictions cannot prevent creating a new identity.",
      ],
    };
  }
  if (view === "boards") {
    return rows(
      await service.query(
        "select b.*, (select count(*) from public.game_best_scores s where s.leaderboard_id=b.id) as active_players, (select count(*) from sg_private.game_submission_events e where e.leaderboard_id=b.id) as submissions from public.game_leaderboards b order by id limit 100",
      ),
    );
  }
  if (view === "leaderboard" || view === "player" || view === "score") {
    const target = targetFor(
      view === "leaderboard" ? "leaderboard.inspect" : view,
      data.target,
    );
    const generation = data.generation === undefined
      ? undefined
      : Number(data.generation);
    const result = rows(
      await service.query(adminInspection(view, target, generation)),
    )[0]?.result;
    if (!object(result)) {
      throw new AdminFailure("NOT_FOUND", "Target was not found.", 404);
    }
    return result;
  }
  if (view === "scores") {
    const where = [`leaderboard_id=${literal(board(data.board))}`];
    if (data.search !== undefined && data.search !== "") {
      const id = literal(uuid(data.search));
      where.push(`(id=${id}::uuid or user_id=${id}::uuid)`);
    }
    if (data.generation !== undefined && data.generation !== "") {
      const n = Number(data.generation);
      if (!Number.isSafeInteger(n) || n < 1) {
        throw new AdminFailure("INVALID_REQUEST", "Invalid generation.");
      }
      where.push(`generation=${n}`);
    }
    if (data.cursor !== undefined) {
      const c = fields(data.cursor, ["time", "id"]);
      const time = text(c.time, 40);
      if (
        !/^\d{4}-\d\d-\d\dT[0-9:.+-]+Z?$/.test(time) ||
        !Number.isFinite(Date.parse(time))
      ) throw new AdminFailure("INVALID_REQUEST", "Invalid cursor.");
      where.push(
        `(created_at,id)<(${literal(time)}::timestamptz,${
          literal(uuid(c.id))
        }::uuid)`,
      );
    }
    const result = rows(
      await service.query(
        `select id,user_id,leaderboard_id,submitted_score,created_at,generation,hidden,moderation_reason,admin_revision from sg_private.game_submission_events where ${
          where.join(" and ")
        } order by created_at desc,id desc limit 51`,
      ),
    );
    const last = result[49];
    return {
      items: result.slice(0, 50),
      next: result.length > 50 && last
        ? { time: last.created_at, id: last.id }
        : null,
    };
  }
  if (view === "players") {
    const search = data.search === undefined ? "" : text(data.search, 120);
    const where = search
      ? `where strpos(lower(coalesce(p.display_name,'')),lower(${
        literal(search)
      }))>0 or p.user_id::text=${literal(search)}`
      : "";
    return rows(
      await service.query(
        `select p.user_id,p.display_name,p.hidden,coalesce(r.restricted,false) as restricted,coalesce(r.revision,0) as revision from public.game_players p left join sg_private.admin_restrictions r on r.user_id=p.user_id ${where} order by p.user_id limit 50`,
      ),
    );
  }
  if (view === "audit") {
    return rows(
      await service.query(
        "select operation_id,actor,action,target_type,target,created_at,reason,outcome,before_state,after_state from sg_private.admin_audit order by created_at desc,operation_id desc limit 100",
      ),
    );
  }
  throw new AdminFailure("INVALID_REQUEST", "Unknown view.");
}
interface Preview {
  id: string;
  action: AdminAction;
  target: string;
  revision: number;
  state: Record<string, unknown>;
  expires: number;
  reason?: string;
  result?: unknown;
  running?: boolean;
}
export class DashboardOperations {
  private previews = new Map<string, Preview>();
  private service: AdminService;
  constructor(service: AdminService) {
    this.service = service;
  }
  async preview(input: unknown) {
    const data = fields(input, ["action", "target"]);
    if (!actions.includes(data.action as AdminAction)) {
      throw new AdminFailure("INVALID_REQUEST", "Unknown action.");
    }
    const action = data.action as AdminAction,
      target = targetFor(action, data.target);
    const kind = action.split(".")[0] as AdminKind;
    const state = await readView(this.service, {
      view: kind,
      target,
    }) as Record<string, unknown>;
    const revision = Number(state.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new AdminFailure(
        "READ_FAILED",
        "Unsupported target revision.",
        503,
      );
    }
    for (const [id, p] of this.previews) {
      if (p.expires < Date.now() && !p.running) this.previews.delete(id);
    }
    if (this.previews.size >= 100) {
      throw new AdminFailure(
        "BUSY",
        "Too many previews. Restart or wait for previews to expire.",
        429,
      );
    }
    const p: Preview = {
      id: randomUUID(),
      action,
      target,
      revision,
      state,
      expires: Date.now() + 600000,
    };
    this.previews.set(p.id, p);
    return {
      ...p,
      project: {
        name: this.service.target.name,
        ref: this.service.target.ref,
        environment: this.service.target.environment,
      },
    };
  }
  async execute(input: unknown) {
    const data = fields(input, ["previewId", "reason", "confirmation"]);
    const p = this.previews.get(uuid(data.previewId));
    if (!p || p.expires < Date.now()) {
      throw new AdminFailure(
        "PREVIEW_EXPIRED",
        "Preview expired. Inspect audit history before creating another operation.",
        409,
      );
    }
    const reason = text(data.reason, 1000);
    if (!reason.trim() || data.confirmation !== p.target) {
      throw new AdminFailure(
        "CONFIRMATION_REQUIRED",
        "Enter a reason and type the exact target to confirm.",
      );
    }
    if (p.reason !== undefined && p.reason !== reason) {
      throw new AdminFailure(
        "OPERATION_CONFLICT",
        "Retry must use the original reason.",
        409,
      );
    }
    this.service.revalidate();
    if (p.result !== undefined) {
      return { result: p.result, operationId: p.id, replayed: true };
    }
    if (p.running) {
      throw new AdminFailure(
        "IN_PROGRESS",
        "Operation is still running. Retry the same operation after it finishes.",
        409,
      );
    }
    p.reason = reason;
    p.running = true;
    const operation: AdminOperation = {
      action: p.action,
      target: p.target,
      revision: p.revision,
      operationId: p.id,
      reason,
    };
    try {
      const result = rows(await this.service.execute(operation))[0]?.result;
      if (!object(result)) {
        throw new AdminFailure(
          "OUTCOME_UNKNOWN",
          "Unverifiable response. Retry the same operation.",
          503,
        );
      }
      p.result = result;
      return { result, operationId: p.id, replayed: false };
    } finally {
      p.running = false;
    }
  }
}
