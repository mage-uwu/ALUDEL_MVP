import { useEffect, useMemo, useRef, useState } from "react";
import { Logo } from "./logo";
import { Check, ChevronLeft, ChevronRight, Grip, More, Pencil, Plus, X } from "./icons";
import {
  type AludelPlace,
  type Block,
  type BlockKind,
  type Task,
  type Template,
} from "../shared/model";
import { loadMaps, PLACE_FIELDS, toAludelPlace } from "./maps";

type Role = "owner" | "admin" | "member";

interface Account {
  id: string;
  email: string;
  name: string;
  picture: string;
}
interface TeamRef {
  id: string;
  name: string;
  role: Role;
}
/** Browser-side Maps config: a referrer-restricted public key (null = maps off) and a map id. */
interface MapsConfig {
  key: string | null;
  mapId: string;
}
interface Me {
  user: Account;
  teams: TeamRef[];
  maps: MapsConfig;
}
interface Member {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: Role;
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

type Section = "templates" | "sites";

interface ListRef {
  id: string;
  name: string;
  sites: number;
}
interface SiteRow {
  id: string;
  clientName: string;
  address: string;
  emails: string[];
  listId: string | null;
  listName: string | null;
  dispatches: number;
}
interface Dispatch {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  currentVersion: number;
  createdAt: string;
}
interface SiteDoc {
  id: string;
  clientName: string;
  /** Derived by the server from place.formattedAddress; empty when there is no place. */
  address: string;
  place: AludelPlace | null;
  emails: string[];
  listId: string | null;
  dispatches: Dispatch[];
}

class Unauthorized extends Error {}

const signIn = (returnTo = location.pathname) => {
  location.href = `/auth/login?return=${encodeURIComponent(returnTo)}`;
};

const remember = (key: string, value: string | null) => {
  try {
    value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; team choice just won't persist */
  }
};
const recall = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

interface Meta {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
  tasks: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ago = (iso: string): string => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s) || s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
type Loaded = Template & { id: string; version: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const short = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/i, (m) => `${m.slice(0, 8)}…`);
  termLog(`$ ${init?.method ?? "GET"} /api${short} → ${res.status}`);
  if (res.status === 401) throw new Unauthorized("Sign in required");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// Wide-screen console pane: a tiny external store the Terminal subscribes to.
const term = { lines: [] as string[], doc: "", subs: new Set<() => void>() };
const termLog = (line: string) => {
  term.lines = [...term.lines.slice(-39), line];
  term.subs.forEach((f) => f());
};
const termDoc = (doc: string) => {
  term.doc = doc;
  term.subs.forEach((f) => f());
};

const dumpTemplate = (t: Loaded): string =>
  [
    `template "${t.name}"  v${t.version}`,
    ...t.tasks.flatMap((k) => [
      ``,
      `  task "${k.name}"`,
      ...k.blocks.map((b) =>
        b.kind === "button"
          ? `    button [${b.label.toUpperCase() || "?"}]`
          : `    ${b.kind.padEnd(6)} "${b.label}"${b.unit ? `  (${b.unit})` : ""}`
      ),
    ]),
  ].join("\n");

const BANNER = [
  "    _     _      _   _  ____   _____  _     ",
  "   / \\   | |    | | | ||  _ \\ | ____|| |    ",
  "  / _ \\  | |    | | | || | | ||  _|  | |    ",
  " / ___ \\ | |___ | |_| || |_| || |___ | |___ ",
  "/_/   \\_\\|_____| \\___/ |____/ |_____||_____|",
  "",
].join("\n");

function Terminal() {
  const [, force] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    term.subs.add(f);
    return () => void term.subs.delete(f);
  }, []);
  useEffect(() => {
    body.current?.scrollTo(0, 1e9);
  });
  return (
    <aside className="terminal" aria-hidden="true">
      <div className="term-bar">
        <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
        <Logo size={14} className="term-mark" />
        <span className="term-title">aludel — console</span>
      </div>
      <div className="term-body" ref={body}>
        <pre className="term-banner">{BANNER}</pre>
        {term.lines.map((l, i) => (
          <div key={i} className="term-line">{l}</div>
        ))}
        {term.doc && <pre className="term-doc">{term.doc}</pre>}
        <div className="term-line">$ <span className="caret" /></div>
      </div>
    </aside>
  );
}

const uid = () => crypto.randomUUID();
const reorder = <T,>(xs: T[], from: number, to: number): T[] => {
  const out = [...xs];
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
};

// Touch-friendly drag-to-reorder over a vertical list. The handle carries
// touch-action:none so the gesture never turns into a scroll; items reorder
// live once the pointer crosses a sibling's midpoint.
function useSortable(onMove: (from: number, to: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(-1);
  const at = useRef(-1);
  const start = (index: number) => (e: React.PointerEvent) => {
    if (e.button > 0) return;
    e.preventDefault();
    at.current = index;
    setDragging(index);
    const onPointerMove = (ev: PointerEvent) => {
      const kids = ref.current ? ([...ref.current.children] as HTMLElement[]) : [];
      const from = at.current;
      let to = from;
      kids.forEach((k, i) => {
        const mid = k.getBoundingClientRect().top + k.offsetHeight / 2;
        if (i < from && ev.clientY < mid) to = Math.min(to, i);
        if (i > from && ev.clientY > mid) to = Math.max(to, i);
      });
      if (to !== from) {
        onMove(from, to);
        at.current = to;
        setDragging(to);
      }
    };
    const end = () => {
      at.current = -1;
      setDragging(-1);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return { ref, dragging, start };
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [teamId, setTeamId] = useState<string | null>(() => recall("team"));
  const [screen, setScreen] = useState<"templates" | "members">("templates");
  const [section, setSection] = useState<Section>(() => (recall("section") === "sites" ? "sites" : "templates"));
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSite, setOpenSite] = useState<string | null>(null);
  const inviteToken = location.pathname.startsWith("/invite/")
    ? location.pathname.slice("/invite/".length)
    : null;

  const load = () =>
    api<Me>("/me").then(
      (m) => {
        setMe(m);
        setTeamId((current) => {
          const keep = m.teams.find((t) => t.id === current);
          return (keep ?? m.teams[0])?.id ?? null;
        });
      },
      (e) => setMe(e instanceof Unauthorized ? null : null)
    );

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    remember("team", teamId);
  }, [teamId]);
  useEffect(() => {
    remember("section", section);
  }, [section]);

  const team = me?.teams.find((t) => t.id === teamId) ?? null;

  const body = () => {
    if (me === undefined) return <p className="empty">Loading…</p>;
    if (inviteToken) return <AcceptInvite token={inviteToken} me={me} onDone={load} />;
    if (me === null) return <SignIn />;
    if (!team) return <NewTeam onCreated={load} />;
    if (screen === "members")
      return <Members team={team} me={me} onBack={() => setScreen("templates")} onChanged={load} />;
    if (openId) return <Editor teamId={team.id} id={openId} onBack={() => setOpenId(null)} />;
    if (openSite) return <SiteEditor teamId={team.id} id={openSite} maps={me.maps} onBack={() => setOpenSite(null)} />;
    const head = (
      <HomeHeader
        team={team}
        me={me}
        section={section}
        onSection={setSection}
        onMembers={() => setScreen("members")}
        onSwitch={setTeamId}
      />
    );
    return section === "sites" ? (
      <Sites team={team} head={head} onOpen={setOpenSite} />
    ) : (
      <Home team={team} head={head} onOpen={setOpenId} />
    );
  };

  return (
    <div className="layout">
      <Terminal />
      {/* On wide screens the app runs in a phone-shaped frame — the aspect
          and the dark chassis carry it, no imitation hardware. */}
      <div className="device">
        <div className="screen">
          <main className="pane">{body()}</main>
        </div>
      </div>
    </div>
  );
}

function SignIn() {
  return (
    <div className="shell gate">
      <div className="gate-body">
        <section className="card glass-frosted gate-card">
          <span className="mark" aria-hidden="true"><Logo size={40} /></span>
          <h1 className="brand">ALUDEL</h1>
          <p className="gate-hint">Form templates for your team.</p>
        </section>
      </div>
      <div className="dock">
        <button className="big-btn primary" onClick={() => signIn()}>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

function NewTeam({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api("/teams", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="shell gate">
      <div className="gate-body">
        <section className="card glass-frosted gate-card">
          <h1 className="gate-title">Name your team</h1>
          <p className="gate-hint">Templates and members live inside a team. You can invite people next.</p>
          <input
            className="text-input"
            value={name}
            maxLength={80}
            placeholder="Acme Pools"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            aria-label="Team name"
          />
          {error && <p className="error">{error}</p>}
        </section>
      </div>
      <div className="dock">
        <button className="big-btn primary" disabled={!name.trim() || busy} onClick={create}>
          Create team
        </button>
      </div>
    </div>
  );
}

function AcceptInvite({ token, me, onDone }: { token: string; me: Me | null; onDone: () => void }) {
  const [state, setState] = useState<"ready" | "working" | "done">("ready");
  const [error, setError] = useState("");
  const [team, setTeam] = useState("");

  const accept = async () => {
    setState("working");
    try {
      const res = await api<{ team: { name: string } }>("/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setTeam(res.team.name);
      setState("done");
      history.replaceState(null, "", "/");
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setState("ready");
    }
  };

  return (
    <div className="shell gate">
      <div className="gate-body">
        <section className="card glass-frosted gate-card">
          <h1 className="gate-title">{state === "done" ? `Welcome to ${team}` : "You have been invited"}</h1>
          {state !== "done" && (
            <p className="gate-hint">
              {me
                ? `Accepting as ${me.user.email}. Invites are tied to the address they were sent to.`
                : "Sign in with the address the invite was sent to."}
            </p>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
      <div className="dock">
        {state === "done" ? (
          <button className="big-btn primary" onClick={() => (location.href = "/")}>
            Open templates
          </button>
        ) : me ? (
          <button className="big-btn primary" disabled={state === "working"} onClick={accept}>
            Accept invite
          </button>
        ) : (
          <button className="big-btn primary" onClick={() => signIn(location.pathname)}>
            Sign in with Google
          </button>
        )}
      </div>
    </div>
  );
}

function HomeHeader({
  team,
  me,
  section,
  onSection,
  onMembers,
  onSwitch,
}: {
  team: TeamRef;
  me: Me;
  section: Section;
  onSection: (s: Section) => void;
  onMembers: () => void;
  onSwitch: (id: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <header className="home-head">
      <Logo size={30} className="home-mark" />
      <div className="home-title">
        <h1>{section === "sites" ? "Sites" : "Templates"}</h1>
        <span className="team-name">{team.name}</span>
      </div>
      <div className="menu-wrap">
        <button
          className="icon-btn"
          aria-label="Menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <More />
        </button>
        {menu && (
          <>
            <div className="menu-scrim" onClick={() => setMenu(false)} />
            <div className="menu" role="menu">
              {(["templates", "sites"] as const).map((sec) => (
                <button
                  key={sec}
                  className={`menu-item${section === sec ? " current" : ""}`}
                  role="menuitemradio"
                  aria-checked={section === sec}
                  onClick={() => { setMenu(false); onSection(sec); }}
                >
                  {sec === "templates" ? "Templates" : "Sites"}
                  {section === sec && <span className="tick" aria-hidden="true"><Check /></span>}
                </button>
              ))}
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => { setMenu(false); onMembers(); }}>
                Members
              </button>
              {me.teams.length > 1 && (
                <>
                  <p className="menu-label">Switch team</p>
                  {me.teams.map((t) => (
                    <button
                      key={t.id}
                      className={`menu-item${t.id === team.id ? " current" : ""}`}
                      role="menuitem"
                      onClick={() => { setMenu(false); onSwitch(t.id); }}
                    >
                      {t.name}
                    </button>
                  ))}
                </>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item"
                role="menuitem"
                onClick={async () => {
                  await fetch("/auth/logout", { method: "POST" });
                  location.href = "/";
                }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function Home({
  team,
  head,
  onOpen,
}: {
  team: TeamRef;
  head: React.ReactNode;
  onOpen: (id: string) => void;
}) {
  const [list, setList] = useState<Meta[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setList(null);
    api<Meta[]>(`/teams/${team.id}/templates`).then((xs) => {
      setList(xs);
      termDoc(
        [`templates (${xs.length})`, ...xs.map((t) => `  ${t.name}  v${t.version}`)].join("\n")
      );
    }, (e) => setError(e.message));
  }, [team.id]);

  const create = async () => {
    try {
      const { id } = await api<{ id: string }>(`/teams/${team.id}/templates`, {
        method: "POST",
        body: JSON.stringify({ name: "Untitled template" }),
      });
      onOpen(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="shell">
      {head}

      {error && <p className="error">{error}</p>}

      {list?.map((t) => (
        <button key={t.id} className="card glass-frosted template-card" onClick={() => onOpen(t.id)}>
          <span className="template-text">
            <span className="template-name">{t.name}</span>
            <span className="template-meta">
              {plural(t.tasks, "task")} · updated {ago(t.updatedAt)}
            </span>
          </span>
          <span className="version">v{t.version}</span>
          <span className="chevron" aria-hidden="true"><ChevronRight /></span>
        </button>
      ))}

      {list?.length === 0 && (
        <div className="empty">
          <p className="empty-title">No templates yet</p>
          <p className="empty-hint">Start one and add tasks, photos, fields and buttons.</p>
        </div>
      )}

      <div className="dock">
        <button className="big-btn primary" onClick={create}>+ New template</button>
      </div>
    </div>
  );
}

function Editor({ teamId, id, onBack }: { teamId: string; id: string; onBack: () => void }) {
  const [tpl, setTpl] = useState<Loaded | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const dirty = useMemo(
    () => !!tpl && JSON.stringify({ name: tpl.name, tasks: tpl.tasks }) !== saved,
    [tpl, saved]
  );

  useEffect(() => {
    api<Loaded>(`/teams/${teamId}/templates/${id}`).then((t) => {
      setTpl(t);
      setSaved(JSON.stringify({ name: t.name, tasks: t.tasks }));
    }, (e) => setError(e.message));
  }, [teamId, id]);

  useEffect(() => {
    if (tpl) termDoc(dumpTemplate(tpl));
  }, [tpl]);

  const taskSort = useSortable((from, to) =>
    setTpl((p) => p && { ...p, tasks: reorder(p.tasks, from, to) })
  );

  if (!tpl) return <div className="shell">{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  // Functional updates so a drag's rapid successive moves never act on stale state.
  const patchTask = (taskId: string, fn: (t: Task) => Task) =>
    setTpl((p) => p && { ...p, tasks: p.tasks.map((t) => (t.id === taskId ? fn(t) : t)) });

  const addTask = () =>
    setTpl({
      ...tpl,
      tasks: [
        ...tpl.tasks,
        { id: uid(), name: "New task", blocks: [] },
      ],
    });

  const save = async () => {
    try {
      const body = { name: tpl.name, tasks: tpl.tasks };
      const { version } = await api<{ version: number }>(`/teams/${teamId}/templates/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setTpl({ ...tpl, version });
      setSaved(JSON.stringify(body));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${tpl.name}" forever?`)) return;
    try {
      await api(`/teams/${teamId}/templates/${id}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const back = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onBack();
  };

  return (
    <div className="shell editor">
      <header className="editor-top">
        <button className="icon-btn" onClick={back} aria-label="Back"><ChevronLeft /></button>
        <input
          className="title-input"
          value={tpl.name}
          maxLength={80}
          onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
          aria-label="Template name"
        />
        <span className="version">v{tpl.version}</span>
        <div className="menu-wrap">
          <button
            className="icon-btn"
            aria-label="Options"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <More />
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu" role="menu">
                <button
                  className="menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    remove();
                  }}
                >
                  Delete template
                </button>
              </div>
            </>
          )}
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="task-list" ref={taskSort.ref}>
        {tpl.tasks.map((task, i) => (
          <TaskCard
            key={task.id}
            task={task}
            dragging={taskSort.dragging === i}
            patch={(fn) => patchTask(task.id, fn)}
            onHandleDown={taskSort.start(i)}
            onRemove={() => setTpl((p) => p && { ...p, tasks: p.tasks.filter((t) => t.id !== task.id) })}
          />
        ))}
      </div>
      <button className="big-btn" onClick={addTask}>+ Add task</button>
      {dirty && (
        <div className="dock">
          <button className="big-btn primary" onClick={save}>Save · v{tpl.version + 1}</button>
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  dragging,
  patch,
  onHandleDown,
  onRemove,
}: {
  task: Task;
  dragging: boolean;
  patch: (fn: (t: Task) => Task) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onRemove: () => void;
}) {
  const blockSort = useSortable((from, to) =>
    patch((t) => ({ ...t, blocks: reorder(t.blocks, from, to) }))
  );

  const addBlock = (kind: BlockKind) =>
    patch((t) => ({
      ...t,
      blocks: [
        ...t.blocks,
        {
          id: uid(),
          kind,
          label: { photo: "Photo", text: "Text", number: "Number", button: "DONE" }[kind],
          unit: "",
        },
      ],
    }));

  return (
    <section className={`card glass-frosted task${dragging ? " dragging" : ""}`}>
      <div className="task-head">
        <input
          className="task-name"
          value={task.name}
          maxLength={80}
          onChange={(e) => patch((t) => ({ ...t, name: e.target.value }))}
          aria-label="Task name"
        />
        <RowControls onHandleDown={onHandleDown} onRemove={onRemove} />
      </div>
      <div className="block-list" ref={blockSort.ref}>
        {task.blocks.map((block, i) => (
          <BlockRow
            key={block.id}
            block={block}
            dragging={blockSort.dragging === i}
            onChange={(b) => patch((t) => ({ ...t, blocks: t.blocks.map((x) => (x.id === b.id ? b : x)) }))}
            onHandleDown={blockSort.start(i)}
            onRemove={() => patch((t) => ({ ...t, blocks: t.blocks.filter((x) => x.id !== block.id) }))}
          />
        ))}
      </div>

      <div className="add-row">
        <button onClick={() => addBlock("photo")}>+ Photo</button>
        <button onClick={() => addBlock("text")}>+ Text</button>
        <button onClick={() => addBlock("number")}>+ Number</button>
        <button onClick={() => addBlock("button")}>+ Button</button>
      </div>
    </section>
  );
}

function BlockRow({
  block,
  dragging,
  onChange,
  onHandleDown,
  onRemove,
}: {
  block: Block;
  dragging: boolean;
  onChange: (b: Block) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onRemove: () => void;
}) {
  if (block.kind === "button") {
    return (
      <div className={`block button-block${dragging ? " dragging" : ""}`}>
        <input
          className="button-key"
          value={block.label}
          maxLength={60}
          onChange={(e) => onChange({ ...block, label: e.target.value })}
          aria-label="Button label"
        />
        <RowControls onHandleDown={onHandleDown} onRemove={onRemove} />
      </div>
    );
  }

  return (
    <div className={`block${dragging ? " dragging" : ""}`}>
      <div className="block-head">
        <input
          className="block-label"
          value={block.label}
          maxLength={60}
          onChange={(e) => onChange({ ...block, label: e.target.value })}
          aria-label="Block label"
        />
        <RowControls onHandleDown={onHandleDown} onRemove={onRemove} />
      </div>
      {block.kind === "photo" && (
        <div className="photo-drop"><span className="lens" />Take or choose a photo</div>
      )}
      {block.kind === "text" && <div className="faux-input tall">Type here…</div>}
      {block.kind === "number" && (
        <div className="number-row">
          <div className="faux-input grow">123</div>
          <input
            className="unit"
            value={block.unit}
            maxLength={12}
            placeholder="unit"
            onChange={(e) => onChange({ ...block, unit: e.target.value })}
            aria-label="Unit"
          />
        </div>
      )}
    </div>
  );
}

function RowControls({
  onHandleDown,
  onRemove,
}: {
  onHandleDown: (e: React.PointerEvent) => void;
  onRemove: () => void;
}) {
  return (
    <span className="row-controls">
      <button className="icon-btn handle" aria-label="Drag to reorder" onPointerDown={onHandleDown}><Grip /></button>
      <button className="icon-btn danger" aria-label="Remove" onClick={onRemove}><X /></button>
    </span>
  );
}

function Members({
  team,
  me,
  onBack,
  onChanged,
}: {
  team: TeamRef;
  me: Me;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const admin = team.role === "owner" || team.role === "admin";
  const onlyOwner = (m: Member) =>
    m.role === "owner" && (members ?? []).filter((x) => x.role === "owner").length <= 1;

  const load = () => {
    api<Member[]>(`/teams/${team.id}/members`).then(setMembers, (e) => setError(e.message));
    if (admin) api<Invite[]>(`/teams/${team.id}/invites`).then(setInvites, () => setInvites([]));
  };
  useEffect(load, [team.id]);

  const guard = (fn: () => Promise<unknown>) => async () => {
    setError("");
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const invite = guard(async () => {
    const res = await api<{ token: string }>(`/teams/${team.id}/invites`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
    setLink(`${location.origin}/invite/${res.token}`);
    setEmail("");
  });

  return (
    <div className="shell">
      <header className="editor-top">
        <button className="icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft /></button>
        <span className="head-title">Members</span>
        <span className="version">{team.role}</span>
      </header>

      {error && <p className="error">{error}</p>}

      {members?.map((m) => (
        <div key={m.id} className="card glass-frosted member-row">
          <span className="template-text">
            <span className="member-name">{m.name || m.email}</span>
            <span className="template-meta">{m.email}</span>
          </span>
          {team.role === "owner" && m.id !== me.user.id ? (
            <select
              className="role-select"
              value={m.role}
              aria-label={`Role for ${m.email}`}
              onChange={(e) =>
                guard(() =>
                  api(`/teams/${team.id}/members/${m.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ role: e.target.value }),
                  })
                )()
              }
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
          ) : (
            <span className="version">{m.role}</span>
          )}
          {(admin || m.id === me.user.id) && !onlyOwner(m) && (
            <button
              className="icon-btn danger"
              aria-label={m.id === me.user.id ? "Leave team" : `Remove ${m.email}`}
              onClick={() => {
                const self = m.id === me.user.id;
                if (!confirm(self ? `Leave ${team.name}?` : `Remove ${m.email} from ${team.name}?`)) return;
                guard(async () => {
                  await api(`/teams/${team.id}/members/${m.id}`, { method: "DELETE" });
                  if (self) location.href = "/";
                })();
              }}
            ><X /></button>
          )}
        </div>
      ))}

      {admin && (
        <section className="card glass-frosted invite-box">
          <p className="section-label">Invite someone</p>
          <input
            className="text-input"
            type="email"
            value={email}
            placeholder="name@company.com"
            maxLength={160}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Invite email"
          />
          <div className="invite-row">
            <select
              className="role-select"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              aria-label="Invite role"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button className="big-btn" disabled={!email.trim()} onClick={invite}>
              Send invite
            </button>
          </div>
          {link && (
            <div className="invite-link">
              <p className="template-meta">Share this link — it works once, for that address only.</p>
              <input className="text-input" readOnly value={link} onFocus={(e) => e.target.select()} />
            </div>
          )}
          {invites.map((i) => (
            <div key={i.id} className="pending">
              <span className="template-text">
                <span className="member-name">{i.email}</span>
                <span className="template-meta">invited as {i.role}</span>
              </span>
              <button
                className="icon-btn danger"
                aria-label={`Revoke invite for ${i.email}`}
                onClick={guard(() =>
                  api(`/teams/${team.id}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" })
                )}
              ><X /></button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Sites({
  team,
  head,
  onOpen,
}: {
  team: TeamRef;
  head: React.ReactNode;
  onOpen: (id: string) => void;
}) {
  const [lists, setLists] = useState<ListRef[] | null>(null);
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    Promise.all([
      api<ListRef[]>(`/teams/${team.id}/lists`),
      api<SiteRow[]>(`/teams/${team.id}/sites`),
    ]).then(([ls, ss]) => {
      setLists(ls);
      setSites(ss);
      termDoc(
        [
          `sites (${ss.length}) in ${plural(ls.length, "list")}`,
          ...ss.map(
            (x) =>
              `  ${(x.listName ?? "unlisted").padEnd(14)} ${x.clientName}${x.dispatches ? `  ⇢ ${plural(x.dispatches, "template")}` : ""}`
          ),
        ].join("\n")
      );
    }, (e) => setError(e.message));
  };
  useEffect(load, [team.id]);

  const create = async () => {
    try {
      const { id } = await api<{ id: string }>(`/teams/${team.id}/sites`, {
        method: "POST",
        body: JSON.stringify({ clientName: "New site" }),
      });
      onOpen(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const groups: { key: string; name: string; list: ListRef | null; rows: SiteRow[] }[] = [
    ...(lists ?? []).map((l) => ({ key: l.id, name: l.name, list: l, rows: (sites ?? []).filter((x) => x.listId === l.id) })),
  ];
  const unlisted = (sites ?? []).filter((x) => !x.listId);
  if (unlisted.length) groups.push({ key: "none", name: "Unlisted", list: null, rows: unlisted });

  const row = (x: SiteRow) => (
    <button key={x.id} className="card glass-frosted template-card" onClick={() => onOpen(x.id)}>
      <span className="template-text">
        <span className="template-name">{x.clientName}</span>
        <span className="template-meta">
          {[x.address, x.emails[0] && (x.emails.length > 1 ? `${x.emails[0]} +${x.emails.length - 1}` : x.emails[0])]
            .filter(Boolean)
            .join(" · ") || "No address yet"}
        </span>
      </span>
      {x.dispatches > 0 && <span className="version">{x.dispatches} ⇢</span>}
      <span className="chevron" aria-hidden="true"><ChevronRight /></span>
    </button>
  );

  return (
    <div className="shell">
      {head}
      {error && <p className="error">{error}</p>}

      {groups.map((g) => (
        <section key={g.key} className="group">
          <div className="group-head">
            <span className={`group-name${g.list ? "" : " muted"}`}>{g.name}</span>
            <span className="group-count">{plural(g.rows.length, "site")}</span>
          </div>
          {g.rows.map(row)}
          {g.rows.length === 0 && <p className="group-empty">No sites in this list yet.</p>}
        </section>
      ))}

      {sites?.length === 0 && lists?.length === 0 && (
        <div className="empty">
          <p className="empty-title">No sites yet</p>
          <p className="empty-hint">A site is a client, an address and who to email. Put sites in lists from inside the site; dispatch templates to them.</p>
        </div>
      )}

      <div className="dock">
        <button className="big-btn primary" onClick={create}>+ New site</button>
      </div>
    </div>
  );
}

function SiteEditor({ teamId, id, maps, onBack }: { teamId: string; id: string; maps: MapsConfig; onBack: () => void }) {
  const [site, setSite] = useState<SiteDoc | null>(null);
  const [lists, setLists] = useState<ListRef[]>([]);
  const [templates, setTemplates] = useState<Meta[]>([]);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);

  const [wizard, setWizard] = useState(false);
  const [listSheet, setListSheet] = useState(false);
  const [placeSheet, setPlaceSheet] = useState(false);
  const fields = (x: SiteDoc) => ({ clientName: x.clientName, place: x.place, emails: x.emails, listId: x.listId });
  const dirty = useMemo(() => !!site && JSON.stringify(fields(site)) !== saved, [site, saved]);

  const load = () =>
    api<SiteDoc>(`/teams/${teamId}/sites/${id}`).then((x) => {
      setSite(x);
      setSaved(JSON.stringify(fields(x)));
    }, (e) => setError(e.message));

  useEffect(() => {
    load();
    api<ListRef[]>(`/teams/${teamId}/lists`).then(setLists, () => setLists([]));
    api<Meta[]>(`/teams/${teamId}/templates`).then(setTemplates, () => setTemplates([]));
  }, [teamId, id]);

  useEffect(() => {
    if (!site) return;
    const listName = lists.find((l) => l.id === site.listId)?.name ?? "unlisted";
    termDoc(
      [
        `site "${site.clientName}"`,
        `  ${site.place ? `${site.place.formattedAddress}  (${site.place.lat.toFixed(5)}, ${site.place.lng.toFixed(5)})` : "—"}`,
        `  ${site.emails.join(", ") || "—"}  ·  ${listName}`,
        ``,
        ...(site.dispatches.length
          ? site.dispatches.map((d) => `  ⇢ "${d.templateName}"  v${d.templateVersion}`)
          : [`  (nothing dispatched)`]),
      ].join("\n")
    );
  }, [site, lists]);

  if (!site) return <div className="shell">{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const patch = (p: Partial<SiteDoc>) => setSite((s) => s && { ...s, ...p });

  const save = async () => {
    try {
      await api(`/teams/${teamId}/sites/${id}`, { method: "PATCH", body: JSON.stringify(fields(site)) });
      setSaved(JSON.stringify(fields(site)));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${site.clientName}" and its dispatches?`)) return;
    try {
      await api(`/teams/${teamId}/sites/${id}`, { method: "DELETE" });
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const dispatch = async (templateId: string) => {
    setPicker(false);
    try {
      await api(`/teams/${teamId}/sites/${id}/dispatches`, { method: "POST", body: JSON.stringify({ templateId }) });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const undispatch = async (d: Dispatch) => {
    if (!confirm(`Remove "${d.templateName}" from this site?`)) return;
    try {
      await api(`/teams/${teamId}/sites/${id}/dispatches/${d.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const back = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onBack();
  };

  const available = templates.filter((t) => !site.dispatches.some((d) => d.templateId === t.id));

  return (
    <div className="shell editor">
      <header className="editor-top">
        <button className="icon-btn" onClick={back} aria-label="Back"><ChevronLeft /></button>
        <h1 className="site-title">
          {[site.clientName.trim(), site.place?.name ?? ""].filter(Boolean).join(" · ") || "New site"}
        </h1>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="Options" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <More />
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu" role="menu">
                <button className="menu-item danger" role="menuitem" onClick={() => { setMenu(false); remove(); }}>
                  Delete site
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="card glass-frosted task">
        <label className="field">
          <span className="section-label">Client name</span>
          <input className="text-input left" value={site.clientName} maxLength={80} placeholder="Smith residence"
            onChange={(e) => patch({ clientName: e.target.value })} />
        </label>
        <div className="field">
          <span className="section-label">Location</span>
          <button className={`row-btn${site.place ? " tall" : ""}`} onClick={() => setPlaceSheet(true)} aria-label="Choose location">
            <span className="row-btn-text">
              {site.place ? (
                <>
                  {site.place.name}
                  <span className="place-addr">{site.place.formattedAddress}</span>
                </>
              ) : (
                <span className="placeholder">Find it on the map</span>
              )}
            </span>
            <span className="chevron" aria-hidden="true"><ChevronRight /></span>
          </button>
          {site.place && <p className="attribution">Place data by Google</p>}
        </div>
        <div className="field">
          <span className="section-label">Emails</span>
          <button className="row-btn" onClick={() => setWizard(true)} aria-label="Edit emails">
            <span className="row-btn-text">
              {site.emails.length ? site.emails.join(", ") : <span className="placeholder">Add emails</span>}
            </span>
            <span className="chevron" aria-hidden="true"><ChevronRight /></span>
          </button>
        </div>
        <div className="field">
          <span className="section-label">List</span>
          <button className="row-btn" onClick={() => setListSheet(true)} aria-label="Choose list">
            <span className="row-btn-text">
              {lists.find((l) => l.id === site.listId)?.name ?? <span className="placeholder">Unlisted</span>}
            </span>
            <span className="chevron" aria-hidden="true"><ChevronRight /></span>
          </button>
        </div>
      </section>

      <section className="card glass-frosted task">
        <p className="section-label">Dispatched templates</p>
        {site.dispatches.map((d) => (
          <div key={d.id} className="member-row dispatch-row">
            <span className="template-text">
              <span className="member-name">{d.templateName}</span>
              <span className="template-meta">
                v{d.templateVersion}{d.currentVersion !== d.templateVersion ? ` · template now v${d.currentVersion}` : ""} · {ago(d.createdAt)}
              </span>
            </span>
            <button className="icon-btn danger" aria-label={`Remove ${d.templateName}`} onClick={() => undispatch(d)}><X /></button>
          </div>
        ))}
        {site.dispatches.length === 0 && <p className="group-empty">Nothing dispatched to this site yet.</p>}
        <div className="menu-wrap">
          <div className="add-row">
            <button disabled={available.length === 0} onClick={() => setPicker((p) => !p)}>
              {templates.length === 0 ? "No templates to dispatch" : available.length === 0 ? "All templates dispatched" : "+ Dispatch template"}
            </button>
          </div>
          {picker && (
            <>
              <div className="menu-scrim" onClick={() => setPicker(false)} />
              <div className="menu picker" role="menu">
                {available.map((t) => (
                  <button key={t.id} className="menu-item" role="menuitem" onClick={() => dispatch(t.id)}>
                    {t.name} <span className="template-meta">v{t.version}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {dirty && (
        <div className="dock">
          <button className="big-btn primary" onClick={save}>Save site</button>
        </div>
      )}

      {wizard && (
        <EmailsSheet
          emails={site.emails}
          onDone={(emails) => {
            patch({ emails });
            setWizard(false);
          }}
        />
      )}

      {listSheet && (
        <ListSheet
          teamId={teamId}
          lists={lists}
          selected={site.listId}
          onLists={setLists}
          onDone={(listId) => {
            patch({ listId });
            setListSheet(false);
          }}
        />
      )}

      {placeSheet && (
        <PlaceSheet
          maps={maps}
          place={site.place}
          onDone={(place) => {
            patch({ place, address: place?.formattedAddress ?? "" });
            setPlaceSheet(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Fullscreen place capture: a Google Places autocomplete (the current
 * PlaceAutocompleteElement, not the legacy widget) above a map that plots the
 * chosen place. One fetchFields per selection, normalized on the spot into an
 * AludelPlace; the live Place object is never kept. The choice is staged like
 * every other field and lands on Save site.
 */
function PlaceSheet({
  maps,
  place,
  onDone,
}: {
  maps: MapsConfig;
  place: AludelPlace | null;
  onDone: (place: AludelPlace | null) => void;
}) {
  const [draft, setDraft] = useState(place);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [alert, setAlert] = useState<{ title: string; message: string } | null>(null);
  const pickerHost = useRef<HTMLDivElement>(null);
  const mapHost = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  // picks are numbered so a slow fetch can never overwrite a later pick
  const pick = useRef(0);

  useEffect(() => {
    const key = maps.key;
    if (!key) return setStatus("failed");
    let live = true;
    (async () => {
      try {
        await loadMaps(key);
        const [{ PlaceAutocompleteElement }, { Map }, { AdvancedMarkerElement }] = await Promise.all([
          google.maps.importLibrary("places"),
          google.maps.importLibrary("maps"),
          google.maps.importLibrary("marker"),
        ]);
        if (!live || !pickerHost.current || !mapHost.current) return;

        const picker = new PlaceAutocompleteElement();
        picker.className = "place-picker";
        picker.setAttribute("aria-label", "Search for a place");
        picker.addEventListener("gmp-select", async (ev) => {
          const { placePrediction } = ev as google.maps.places.PlacePredictionSelectEvent;
          const mine = ++pick.current;
          // exactly one fetch per pick: this call closes the autocomplete session
          const next = await placePrediction
            .toPlace()
            .fetchFields({ fields: PLACE_FIELDS })
            .then(({ place }) => toAludelPlace(place), () => null);
          if (!live || mine !== pick.current) return;
          if (next) setDraft(next);
          else setAlert({ title: "Couldn't use that place", message: "Google didn't return a location for it. Try a more specific address." });
        });
        pickerHost.current.replaceChildren(picker);

        mapRef.current = new Map(mapHost.current, {
          mapId: maps.mapId,
          center: { lat: 20, lng: 0 },
          zoom: 1,
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: "greedy",
          clickableIcons: false,
        });
        markerRef.current = new AdvancedMarkerElement({ map: mapRef.current });
        setStatus("ready");
      } catch {
        if (live) setStatus("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [maps.key, maps.mapId]);

  // the marker follows the draft: Google's viewport when it gave one, else street level on the point
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (status !== "ready" || !map || !marker) return;
    if (!draft) {
      marker.position = null;
      return;
    }
    marker.position = { lat: draft.lat, lng: draft.lng };
    marker.title = draft.name;
    if (draft.viewport) map.fitBounds(draft.viewport, 24);
    else {
      map.setCenter({ lat: draft.lat, lng: draft.lng });
      map.setZoom(17);
    }
  }, [draft, status]);

  return (
    <div className="sheet">
      <div className="shell editor">
        <header className="editor-top">
          <button className="icon-btn" onClick={() => onDone(draft)} aria-label="Back"><ChevronLeft /></button>
          <h1 className="site-title">Location</h1>
          {draft && (
            <button className="icon-btn danger" aria-label="Clear location" onClick={() => setDraft(null)}><X /></button>
          )}
        </header>

        <section className="card glass-frosted task">
          <div className="field">
            <span className="section-label">Search</span>
            <div ref={pickerHost} />
            {status === "loading" && <p className="group-empty">Loading Google Maps…</p>}
            {status === "failed" && (
              <p className="group-empty">
                {maps.key
                  ? "Google Maps didn't load. Check the connection and try again."
                  : "Google Maps isn't set up for this deployment yet (GOOGLE_MAPS_BROWSER_KEY)."}
              </p>
            )}
          </div>
          <div className="map-wrap">
            <div ref={mapHost} className="map" aria-label="Map" />
            {status === "ready" && !draft && <span className="map-hint">Pick a place to plot it</span>}
          </div>
          {draft && (
            <div className="place-row">
              <span className="template-text">
                <span className="place-name">{draft.name}</span>
                <span className="place-addr">{draft.formattedAddress}</span>
              </span>
            </div>
          )}
          <p className="attribution">Place data by Google</p>
        </section>

        <div className="dock">
          <button className="big-btn primary" onClick={() => onDone(draft)}>Done</button>
        </div>
      </div>

      {alert && <Modal title={alert.title} message={alert.message} onClose={() => setAlert(null)} />}
    </div>
  );
}

/**
 * Fullscreen picker for a site's list. Lists themselves are team objects, so
 * creating, renaming and deleting them saves immediately; which one the site
 * sits in is staged like every other field and lands on Save site.
 */
function ListSheet({
  teamId,
  lists,
  selected,
  onLists,
  onDone,
}: {
  teamId: string;
  lists: ListRef[];
  selected: string | null;
  onLists: (lists: ListRef[]) => void;
  onDone: (listId: string | null) => void;
}) {
  const [sel, setSel] = useState<string | null>(selected);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [alert, setAlert] = useState<{ title: string; message: string; action?: { label: string; onClick: () => void } } | null>(null);
  const alertOpen = useRef(false);
  alertOpen.current = alert !== null;

  const oops = (e: unknown) => setAlert({ title: "That didn't save", message: (e as Error).message });
  const taken = (name: string, ignore: string | null) =>
    lists.some((l) => l.id !== ignore && l.name.toLowerCase() === name.toLowerCase());

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    if (taken(name, null)) return setAlert({ title: "Already a list", message: `There is already a list called “${name}”.` });
    try {
      const made = await api<ListRef>(`/teams/${teamId}/lists`, { method: "POST", body: JSON.stringify({ name }) });
      onLists([...lists, made]);
      setSel(made.id);
      setDraft("");
    } catch (e) {
      oops(e);
    }
  };

  const commitEdit = async () => {
    if (editing === null) return;
    const name = editDraft.trim();
    if (!name) return setAlert({ title: "Name required", message: "A list needs a name." });
    if (taken(name, editing)) return setAlert({ title: "Already a list", message: `There is already a list called “${name}”.` });
    try {
      await api(`/teams/${teamId}/lists/${editing}`, { method: "PATCH", body: JSON.stringify({ name }) });
      onLists(lists.map((l) => (l.id === editing ? { ...l, name } : l)));
      setEditing(null);
    } catch (e) {
      oops(e);
    }
  };
  const cancelEdit = () => {
    if (!alertOpen.current) setEditing(null);
  };

  const remove = (l: ListRef) =>
    setAlert({
      title: `Delete “${l.name}”?`,
      message: l.sites ? `Its ${plural(l.sites, "site")} will stay, unlisted.` : "This list is empty.",
      action: {
        label: "Delete",
        onClick: async () => {
          setAlert(null);
          try {
            await api(`/teams/${teamId}/lists/${l.id}`, { method: "DELETE" });
            onLists(lists.filter((x) => x.id !== l.id));
            if (sel === l.id) setSel(null);
          } catch (e) {
            oops(e);
          }
        },
      },
    });

  const row = (id: string | null, name: string, l?: ListRef) =>
    editing !== null && editing === id ? (
      <div key={id ?? "none"} className="member-row dispatch-row">
        <input
          className="text-input left"
          autoFocus
          value={editDraft}
          maxLength={80}
          onChange={(ev) => setEditDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") (ev.preventDefault(), commitEdit());
            if (ev.key === "Escape") setEditing(null);
          }}
          onBlur={cancelEdit}
          aria-label={`Rename ${name}`}
        />
        <button className="icon-btn" aria-label="Save name" onPointerDown={(ev) => ev.preventDefault()} onClick={commitEdit}>
          <Check size={18} />
        </button>
      </div>
    ) : (
      <div key={id ?? "none"} className="member-row dispatch-row">
        <button
          className={`email-name pick-row${sel === id ? " picked" : ""}`}
          role="radio"
          aria-checked={sel === id}
          onClick={() => setSel(id)}
        >
          <span className="radio" aria-hidden="true">{sel === id && <Check size={16} />}</span>
          <span className="pick-name">{name}</span>
          {l && <span className="template-meta">{plural(l.sites, "site")}</span>}
        </button>
        {l && (
          <>
            <button className="icon-btn" aria-label={`Rename ${name}`} onClick={() => { setEditing(l.id); setEditDraft(l.name); }}>
              <Pencil />
            </button>
            <button className="icon-btn danger" aria-label={`Delete ${name}`} onClick={() => remove(l)}><X /></button>
          </>
        )}
      </div>
    );

  return (
    <div className="sheet">
      <div className="shell editor">
        <header className="editor-top">
          <button className="icon-btn" onClick={() => onDone(sel)} aria-label="Back"><ChevronLeft /></button>
          <h1 className="site-title">List</h1>
          <span className="version">{plural(lists.length, "list")}</span>
        </header>

        <section className="card glass-frosted task" role="radiogroup" aria-label="List">
          {row(null, "Unlisted")}
          {lists.map((l) => row(l.id, l.name, l))}
          <div className="add-email">
            <input
              className="text-input left"
              value={draft}
              placeholder="New list"
              maxLength={80}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), create())}
              aria-label="New list name"
            />
            <button className="big-btn plus" onClick={create} aria-label="Add list"><Plus /></button>
          </div>
        </section>

        <div className="dock">
          <button className="big-btn primary" onClick={() => onDone(sel)}>Done</button>
        </div>
      </div>

      {alert && <Modal title={alert.title} message={alert.message} action={alert.action} onClose={() => setAlert(null)} />}
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fullscreen editor for a site's contact emails. Mistakes surface as a modal, not a banner. */
function EmailsSheet({ emails, onDone }: { emails: string[]; onDone: (emails: string[]) => void }) {
  const [list, setList] = useState(emails);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [alert, setAlert] = useState<{ title: string; message: string } | null>(null);
  // while a modal is up, focus leaving the row input must not cancel the edit
  const alertOpen = useRef(false);
  alertOpen.current = alert !== null;

  /** Validate one address against the list (ignoring the row being edited). Null means OK. */
  const problem = (raw: string, ignore: number | null): { title: string; message: string } | null => {
    const e = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(e))
      return { title: "Not an email address", message: `“${raw.trim()}” is missing an @ or a domain. Check it and try again.` };
    if (list.some((x, i) => x === e && i !== ignore))
      return { title: "Already on the list", message: `${e} is already one of this site's emails.` };
    return null;
  };

  const add = () => {
    if (!draft.trim()) return;
    if (list.length >= 10)
      return setAlert({ title: "That's the limit", message: "A site can hold up to 10 emails. Remove one to add another." });
    const bad = problem(draft, null);
    if (bad) return setAlert(bad);
    setList([...list, draft.trim().toLowerCase()]);
    setDraft("");
  };

  const startEdit = (i: number) => {
    setEditing(i);
    setEditDraft(list[i] ?? "");
  };
  const commitEdit = () => {
    if (editing === null) return;
    const bad = problem(editDraft, editing);
    if (bad) return setAlert(bad);
    setList(list.map((x, i) => (i === editing ? editDraft.trim().toLowerCase() : x)));
    setEditing(null);
  };
  const cancelEdit = () => {
    if (alertOpen.current) return;
    setEditing(null);
  };

  return (
    <div className="sheet">
      <div className="shell editor">
        <header className="editor-top">
          <button className="icon-btn" onClick={() => onDone(list)} aria-label="Back"><ChevronLeft /></button>
          <h1 className="site-title">Emails</h1>
          <span className="version">{list.length} / 10</span>
        </header>

        <section className="card glass-frosted task">
          {list.map((e, i) =>
            editing === i ? (
              <div key={e} className="member-row dispatch-row">
                <input
                  className="text-input left"
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoFocus
                  value={editDraft}
                  maxLength={160}
                  onChange={(ev) => setEditDraft(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") (ev.preventDefault(), commitEdit());
                    if (ev.key === "Escape") setEditing(null);
                  }}
                  onBlur={cancelEdit}
                  aria-label={`Edit ${e}`}
                />
                <button
                  className="icon-btn"
                  aria-label="Save email"
                  onPointerDown={(ev) => ev.preventDefault()}
                  onClick={commitEdit}
                >
                  <Check size={18} />
                </button>
              </div>
            ) : (
              <div key={e} className="member-row dispatch-row">
                <button className="email-name email-edit" onClick={() => startEdit(i)} aria-label={`Edit ${e}`}>
                  {e}
                </button>
                <button className="icon-btn danger" aria-label={`Remove ${e}`} onClick={() => setList(list.filter((_, j) => j !== i))}><X /></button>
              </div>
            )
          )}
          {list.length === 0 && <p className="group-empty">No emails yet. Add the people who should hear about this site.</p>}
          <div className="add-email">
            <input
              className="text-input left"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoFocus
              value={draft}
              placeholder="name@example.com"
              maxLength={160}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
              aria-label="Email address"
            />
            <button className="big-btn plus" onClick={add} aria-label="Add email"><Plus /></button>
          </div>
        </section>

        <div className="dock">
          <button className="big-btn primary" onClick={() => onDone(list)}>Done</button>
        </div>
      </div>

      {alert && <Modal title={alert.title} message={alert.message} onClose={() => setAlert(null)} />}
    </div>
  );
}

function Modal({
  title,
  message,
  onClose,
  action,
}: {
  title: string;
  message: string;
  onClose: () => void;
  /** A second, committing choice; without it the modal is a plain acknowledgement. */
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="modal-scrim" onClick={onClose} onPointerDown={(e) => e.preventDefault()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
        <p id="modal-title" className="modal-title">{title}</p>
        <p className="modal-msg">{message}</p>
        {action ? (
          <div className="modal-actions">
            <button className="big-btn" onClick={onClose}>Cancel</button>
            <button className="big-btn danger" onClick={action.onClick}>{action.label}</button>
          </div>
        ) : (
          <button className="big-btn" onClick={onClose}>OK</button>
        )}
      </div>
    </div>
  );
}
