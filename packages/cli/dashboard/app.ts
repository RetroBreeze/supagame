type Row = Record<string, unknown>;
type View = "overview" | "boards" | "scores" | "players" | "audit";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let session = "", csrf = "", view: View = "overview", requestNumber = 0;
let project: { name: string; ref: string; environment: string } | undefined;
let scoreCursor: unknown = undefined;
let scoreHistory: unknown[] = [];
let scoreFilter = { board: "", search: "", generation: "" };
let playerSearch = "";
let auditSearch = "";
const labels: Record<View, [string, string]> = {
  overview: [
    "Overview",
    "A clear view of your project and its administrative activity.",
  ],
  boards: [
    "Leaderboards",
    "Manage active competitions while preserving their history.",
  ],
  scores: [
    "Score moderation",
    "Review accepted submissions. Hiding a score preserves its record.",
  ],
  players: [
    "Players",
    "Inspect profiles and manage eligibility for score submissions.",
  ],
  audit: [
    "Audit log",
    "Recent committed operations, attributed to the database operator role.",
  ],
};
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: unknown,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text ?? "—");
  if (className) node.className = className;
  return node;
}
function button(label: string, click: () => void, className?: string) {
  const b = el("button", label, className);
  b.type = "button";
  b.addEventListener("click", click);
  return b;
}
function status(message = "", error = false) {
  $("status").textContent = message;
  $("status").className = error ? "error" : "";
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Request failed. Check the terminal connection.";
}
async function api(
  path: string,
  body: unknown,
  launch?: string,
): Promise<unknown> {
  const requestSession = session;
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${launch ?? session}`,
        ...(launch ? {} : { "x-supagame-csrf": csrf }),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(35000),
    });
  } catch {
    throw new Error(
      "Connection interrupted. The operation outcome may be unknown. Reconnect and inspect audit history; retry only this same operation.",
    );
  }
  const value = await response.json();
  if (!launch && requestSession !== session) {
    throw new Error("Dashboard was locked.");
  }
  if (!response.ok) {
    if (response.status === 401 && !launch) lock();
    throw new Error(`${value.code}: ${value.message}`);
  }
  return value;
}
function read(input: Row) {
  return api("read", input);
}
function lock() {
  session = "";
  csrf = "";
  project = undefined;
  requestNumber++;
  $("content").replaceChildren();
  $("project-name").textContent = "";
  $("project-ref").textContent = "";
  $("app").hidden = true;
  $("login").hidden = false;
  $<HTMLDialogElement>("operation-dialog").close();
  $<HTMLInputElement>("launch-code").focus();
}
$("lock").addEventListener("click", lock);
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("launch-code"),
    submit = $("login-form").querySelector("button")!;
  submit.disabled = true;
  $("login-error").textContent = "";
  try {
    const auth = await api("session", {}, input.value.trim()) as {
      session: string;
      csrf: string;
    };
    session = auth.session;
    csrf = auth.csrf;
    input.value = "";
    $("login").hidden = true;
    $("app").hidden = false;
    await load("overview");
  } catch (error) {
    $("login-error").textContent = message(error);
  } finally {
    submit.disabled = false;
  }
});
for (
  const b of Array.from(
    document.querySelectorAll<HTMLButtonElement>("nav button"),
  )
) b.addEventListener("click", () => void load(b.dataset.view as View));
$("refresh").addEventListener("click", () => void load(view));
function table(
  headers: string[],
  rows: Row[],
  cells: (r: Row) => Array<unknown | Node>,
) {
  if (!rows.length) return el("div", "No records match this view.", "empty");
  const wrap = el("div", undefined, "table-wrap"),
    t = el("table"),
    head = el("thead"),
    tr = el("tr");
  for (const h of headers) {
    const th = el("th", h);
    th.scope = "col";
    tr.append(th);
  }
  head.append(tr);
  t.append(head);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const value of cells(row)) {
      const td = el("td");
      if (value instanceof Node) td.append(value);
      else td.textContent = String(value ?? "—");
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  return wrap;
}
const date = (value: unknown) =>
  typeof value === "string"
    ? new Date(value).toLocaleString()
    : String(value ?? "—");
const badge = (value: unknown, good = true) =>
  el("span", value, good ? "badge" : "badge hosted");
function actionsFor(...buttons: HTMLButtonElement[]) {
  const box = el("div");
  box.append(...buttons);
  return box;
}
function action(label: string, operation: string, target: unknown) {
  return button(label, () => void preview(operation, String(target)));
}
function inputField(label: string, value = "", placeholder = "") {
  const box = el("div"), l = el("label", label), input = el("input");
  input.value = value;
  input.placeholder = placeholder;
  l.append(input);
  box.append(l);
  return { box, input };
}
function formToolbar(onSubmit: () => void) {
  const form = el("form", undefined, "toolbar");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  return form;
}
function submitButton(label: string) {
  const b = el("button", label);
  b.type = "submit";
  return b;
}
function auditTable(rows: Row[]) {
  return table(
    [
      "Time",
      "Action / target",
      "Reason",
      "Operator role",
      "Result",
      "Operation ID",
    ],
    rows,
    (r) => [
      date(r.created_at),
      `${r.action}\n${r.target}`,
      r.reason,
      r.actor,
      r.outcome,
      r.operation_id,
    ],
  );
}
async function load(next: View) {
  view = next;
  const turn = ++requestNumber;
  status("Loading…");
  $("content").setAttribute("aria-busy", "true");
  for (
    const b of Array.from(
      document.querySelectorAll<HTMLButtonElement>("nav button"),
    )
  ) {
    b.classList.toggle("selected", b.dataset.view === view);
    b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false");
  }
  $("page-title").textContent = labels[view][0];
  $("page-description").textContent = labels[view][1];
  const content = document.createDocumentFragment();
  try {
    if (!project || next === "overview") {
      const overview = await read({ view: "overview" }) as {
        project: NonNullable<typeof project>;
        counts: Row;
        activity: Row[];
        warnings: string[];
        security: string;
      };
      if (turn !== requestNumber) return;
      project = overview.project;
      $("project-name").textContent = project.name;
      $("project-ref").textContent = project.ref;
      $("environment").textContent = project.environment.toUpperCase();
      $("environment").className = `badge ${
        project.environment === "hosted" ? "hosted" : ""
      }`;
      if (next === "overview") {
        const cards = el("div", undefined, "cards");
        for (
          const [name, value, caption] of [
            [
              "Leaderboards",
              overview.counts.leaderboards,
              "Configured competitions",
            ],
            ["Players", overview.counts.players, "Profiles in this project"],
            ["Admin status", "Ready", "Verified at session startup"],
          ]
        ) {
          const c = el("div", undefined, "card");
          c.append(
            el("small", name),
            el("div", value, "metric"),
            el("span", caption, "muted"),
          );
          cards.append(c);
        }
        content.append(cards);
        const modules = el("section", undefined, "panel");
        modules.append(el("h2", "Installed modules"));
        modules.append(
          table(
            ["Module", "Version"],
            Object.entries(
              (overview.project as unknown as {
                modules: Record<string, string>;
              }).modules,
            ).map(([name, version]) => ({ name, version })),
            (r) => [r.name, el("code", r.version)],
          ),
        );
        content.append(modules);
        for (const warning of overview.warnings) {
          content.append(el("p", warning, "notice"));
        }
        content.append(
          el("h2", "Recent activity"),
          auditTable(overview.activity.slice(0, 8)),
        );
      }
    }
    if (next === "boards") {
      const rows = await read({ view: "boards" }) as Row[];
      content.append(
        el(
          "p",
          "Showing up to 100 configured boards. Use the ID lookup to inspect any board.",
          "muted",
        ),
      );
      const lookup = inputField("Leaderboard ID", "", "vaccoin");
      const form = formToolbar(() => void inspectBoard(lookup.input.value));
      form.append(lookup.box, submitButton("Inspect board"));
      content.append(form);
      content.append(
        table(
          [
            "Leaderboard",
            "Type / order",
            "Status",
            "Generation",
            "Revision",
            "Active players",
            "Submissions",
            "Actions",
          ],
          rows,
          (r) => [
            el("code", r.id),
            `${r.kind} · ${r.sort_direction}`,
            badge(r.enabled ? "Enabled" : "Disabled", !!r.enabled),
            r.generation,
            r.admin_revision,
            r.active_players,
            r.submissions,
            actionsFor(
              button("Inspect", () => void inspectBoard(String(r.id))),
              action(
                r.enabled ? "Disable" : "Enable",
                r.enabled ? "leaderboard.disable" : "leaderboard.enable",
                r.id,
              ),
            ),
          ],
        ),
      );
    }
    if (next === "scores") {
      const boardField = inputField(
          "Leaderboard ID",
          scoreFilter.board,
          "vaccoin",
        ),
        search = inputField(
          "Submission or player UUID",
          scoreFilter.search,
          "Exact UUID (optional)",
        ),
        generation = inputField("Generation", scoreFilter.generation, "All");
      generation.input.className = "short";
      generation.input.inputMode = "numeric";
      const form = formToolbar(() => {
        scoreFilter = {
          board: boardField.input.value.trim(),
          search: search.input.value.trim(),
          generation: generation.input.value.trim(),
        };
        scoreCursor = undefined;
        scoreHistory = [];
        void load("scores");
      });
      form.append(
        boardField.box,
        search.box,
        generation.box,
        submitButton("Find submissions"),
      );
      content.append(form);
      if (!scoreFilter.board) {
        content.append(
          el(
            "div",
            "Enter a leaderboard ID to review its accepted submissions.",
            "empty",
          ),
        );
      } else {
        const page = await read({
          view: "scores",
          ...scoreFilter,
          ...(scoreCursor ? { cursor: scoreCursor } : {}),
        }) as { items: Row[]; next: unknown };
        content.append(
          table(
            [
              "Submission / player",
              "Score",
              "Created",
              "Generation",
              "Visibility",
              "Actions",
            ],
            page.items,
            (r) => [
              `${r.id}\n${r.user_id}`,
              r.submitted_score,
              date(r.created_at),
              r.generation,
              badge(r.hidden ? "Hidden" : "Visible", !r.hidden),
              actionsFor(
                button(
                  "Inspect",
                  () => void inspectRecord("score", String(r.id)),
                ),
                action(
                  r.hidden ? "Restore" : "Hide",
                  r.hidden ? "score.restore" : "score.hide",
                  r.id,
                ),
              ),
            ],
          ),
        );
        const pager = el("div", undefined, "pager"),
          previous = button("← Previous", () => {
            scoreCursor = scoreHistory.pop();
            void load("scores");
          });
        previous.disabled = !scoreHistory.length;
        const more = button("Next page →", () => {
          scoreHistory.push(scoreCursor);
          scoreCursor = page.next;
          void load("scores");
        });
        more.disabled = !page.next;
        pager.append(
          previous,
          el(
            "small",
            `Page ${scoreHistory.length + 1} · up to 50 accepted submissions`,
          ),
          more,
        );
        content.append(pager);
      }
    }
    if (next === "players") {
      content.append(
        el(
          "p",
          "Restrictions block score submissions only. Accounts, saves, profiles, achievements and sessions are retained. An anonymous player can create a new identity.",
          "notice",
        ),
      );
      const search = inputField(
        "Display name or player UUID",
        playerSearch,
        "Search profiles",
      );
      const form = formToolbar(() => {
        playerSearch = search.input.value.trim();
        void load("players");
      });
      form.append(
        search.box,
        submitButton("Search"),
        button(
          "Inspect exact UUID",
          () => void inspectRecord("player", search.input.value.trim()),
        ),
      );
      content.append(form);
      const rows = await read({
        view: "players",
        ...(playerSearch ? { search: playerSearch } : {}),
      }) as Row[];
      content.append(
        table(
          ["Display name", "Player ID", "Submissions", "Revision", "Actions"],
          rows,
          (r) => [
            r.display_name ?? "Unnamed player",
            r.user_id,
            badge(r.restricted ? "Restricted" : "Eligible", !r.restricted),
            r.revision,
            actionsFor(
              button(
                "Inspect",
                () => void inspectRecord("player", String(r.user_id)),
              ),
              action(
                r.restricted ? "Reinstate" : "Restrict",
                r.restricted ? "player.reinstate" : "player.restrict",
                r.user_id,
              ),
            ),
          ],
        ),
      );
      content.append(
        el(
          "p",
          "Up to 50 matching profiles. Exact UUID inspection also supports Auth identities without a profile.",
          "muted",
        ),
      );
    }
    if (next === "audit") {
      const rows = await read({ view: "audit" }) as Row[];
      const search = inputField(
        "Filter recent activity",
        auditSearch,
        "Action, target, reason or operation ID",
      );
      const form = formToolbar(() => {
        auditSearch = search.input.value.trim();
        void load("audit");
      });
      form.append(search.box, submitButton("Filter"));
      content.append(
        form,
        el(
          "p",
          "Filtering the latest 100 committed operations. Operator is a database role, not a uniquely identified person.",
          "notice",
        ),
      );
      content.append(
        auditTable(
          rows.filter((r) =>
            [r.action, r.target, r.reason, r.operation_id].some((v) =>
              String(v).toLowerCase().includes(auditSearch.toLowerCase())
            )
          ),
        ),
      );
    }
    if (turn !== requestNumber) return;
    $("content").replaceChildren(content);
    status();
  } catch (error) {
    if (turn === requestNumber) {
      $("content").replaceChildren();
      status(message(error), true);
    }
  } finally {
    if (turn === requestNumber) $("content").removeAttribute("aria-busy");
  }
}
async function inspectRecord(kind: "player" | "score", target: string) {
  status("Loading inspection…");
  try {
    const record = await read({ view: kind, target }) as Row;
    const panel = el("section", undefined, "panel");
    panel.append(
      el("h2", `${kind === "player" ? "Player" : "Submission"} inspection`),
      el("pre", JSON.stringify(record, null, 2)),
      action(
        kind === "player"
          ? (record.restricted ? "Reinstate" : "Restrict")
          : (record.hidden ? "Restore" : "Hide"),
        kind === "player"
          ? (record.restricted ? "player.reinstate" : "player.restrict")
          : (record.hidden ? "score.restore" : "score.hide"),
        target,
      ),
    );
    $("content").prepend(panel);
    status();
    panel.scrollIntoView({ block: "start" });
  } catch (e) {
    status(message(e), true);
  }
}
async function inspectBoard(id: string, generation?: number) {
  status("Loading leaderboard…");
  try {
    const r = await read({
      view: "leaderboard",
      target: id,
      ...(generation ? { generation } : {}),
    }) as Row;
    const panel = el("section", undefined, "panel");
    panel.append(
      el("h2", `Leaderboard · ${id}`),
      el(
        "p",
        `Generation ${r.generation} · revision ${r.revision} · ${r.activePlayers} active players`,
      ),
      el(
        "pre",
        JSON.stringify(
          {
            kind: r.kind,
            sortDirection: r.sort_direction,
            min: r.min_value,
            max: r.max_value,
            enabled: r.enabled,
            lastModification: r.lastModification,
          },
          null,
          2,
        ),
      ),
    );
    const acts = el("div", undefined, "actions");
    acts.append(
      action("Preview reset", "leaderboard.reset", id),
      action(
        r.enabled ? "Disable" : "Enable",
        r.enabled ? "leaderboard.disable" : "leaderboard.enable",
        id,
      ),
      button("Review submissions", () => {
        scoreFilter = { board: id, search: "", generation: "" };
        scoreCursor = undefined;
        scoreHistory = [];
        void load("scores");
      }),
    );
    panel.append(acts, el("h2", "Generation history"));
    panel.append(
      table(
        ["Generation", "Accepted submissions", "Review"],
        r.generations as Row[],
        (g) => [
          g.generation,
          g.submissions,
          button("View scores", () => {
            scoreFilter = {
              board: id,
              search: "",
              generation: String(g.generation),
            };
            scoreCursor = undefined;
            scoreHistory = [];
            void load("scores");
          }),
        ],
      ),
    );
    $("content").prepend(panel);
    status();
    panel.scrollIntoView({ block: "start" });
  } catch (error) {
    status(message(error), true);
  }
}
interface Preview {
  id: string;
  action: string;
  target: string;
  revision: number;
  state: Row;
  project: NonNullable<typeof project>;
}
let current: Preview | undefined;
let busy = false, completed = false;
const dialog = $<HTMLDialogElement>("operation-dialog"),
  reason = $<HTMLTextAreaElement>("reason"),
  confirmation = $<HTMLInputElement>("confirmation"),
  execute = $<HTMLButtonElement>("execute");
function validity() {
  execute.disabled = busy || completed || !current || !reason.value.trim() ||
    confirmation.value !== current.target;
}
reason.addEventListener("input", validity);
confirmation.addEventListener("input", validity);
$("cancel-operation").addEventListener("click", () => {
  if (!busy) dialog.close();
});
dialog.addEventListener("cancel", (e) => {
  if (busy) e.preventDefault();
});
async function preview(action: string, target: string) {
  status("Fetching current state for preview…");
  try {
    current = await api("preview", { action, target }) as Preview;
    busy = false;
    completed = false;
    reason.value = "";
    confirmation.value = "";
    reason.disabled = false;
    confirmation.disabled = false;
    execute.textContent = "Confirm operation";
    $("operation-error").textContent = "";
    $("operation-result").textContent = "";
    $("operation-title").textContent = action.replace(".", " · ");
    $("operation-project").textContent =
      `${current.project.environment.toUpperCase()} · ${current.project.name} · ${current.project.ref}`;
    $("operation-impact").textContent = action === "leaderboard.reset"
      ? "Start an empty active generation. Historical scores and achievements remain stored. There is no automatic reset rollback."
      : action.startsWith("score.")
      ? "Recalculate the player’s active ranking. Hiding retains the submission and moderation history; restoring a historical score does not move it to the current generation."
      : action.startsWith("player.")
      ? "Change eligibility for score submissions only. Saves, achievements, accounts and sessions are unaffected."
      : "Change submission availability. Existing rankings and history stay readable.";
    $("operation-state").textContent = JSON.stringify(
      {
        target,
        revision: current.revision,
        generation: current.state.generation,
        enabled: current.state.enabled,
        activePlayers: current.state.activePlayers,
        score: current.state.submitted_score,
        hidden: current.state.hidden,
        restricted: current.state.restricted,
        operationId: current.id,
      },
      null,
      2,
    );
    $("confirmation-label").textContent =
      `Type “${target}” to confirm this target`;
    validity();
    dialog.showModal();
    reason.focus();
    status();
  } catch (error) {
    status(message(error), true);
  }
}
$("operation-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current || execute.disabled) return;
  busy = true;
  reason.disabled = true;
  confirmation.disabled = true;
  validity();
  $("operation-error").textContent = "";
  execute.textContent = "Executing…";
  try {
    const result = await api("execute", {
      previewId: current.id,
      reason: reason.value,
      confirmation: confirmation.value,
    }) as { result: Row; operationId: string; replayed: boolean };
    completed = true;
    $("operation-result").replaceChildren(
      el(
        "p",
        result.replayed
          ? "Operation already processed. Original result:"
          : "Operation committed. Actual result:",
        "success",
      ),
      el("pre", JSON.stringify(result, null, 2)),
    );
    execute.textContent = "Completed";
    void load(view);
  } catch (error) {
    $("operation-error").textContent = message(error);
    execute.textContent = "Retry same operation";
  } finally {
    busy = false;
    validity();
  }
});
