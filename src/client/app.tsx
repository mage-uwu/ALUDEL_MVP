import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Block,
  type BlockKind,
  type Task,
  type Template,
} from "../shared/model";

interface Meta {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}
type Loaded = Template & { id: string; version: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const short = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/i, (m) => `${m.slice(0, 8)}…`);
  termLog(`$ ${init?.method ?? "GET"} /api${short} → ${res.status}`);
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
      ...k.blocks.map((b) => `    ${b.kind.padEnd(6)} "${b.label}"${b.unit ? `  (${b.unit})` : ""}`),
      `    outcomes → ${k.outcomes.map((e) => `[${e.label.toUpperCase() || "?"}]`).join("  ")}`,
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
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="layout">
      <Terminal />
      {/* On wide screens the app runs in a phone-shaped frame — the aspect
          and the dark chassis carry it, no imitation hardware. */}
      <div className="device">
        <div className="screen">
          <main className="pane">
            {openId ? <Editor id={openId} onBack={() => setOpenId(null)} /> : <Home onOpen={setOpenId} />}
          </main>
        </div>
      </div>
    </div>
  );
}

function Tabs() {
  return (
    <nav className="tabs glass-pane">
      <button className="tab active">Templates</button>
      <button className="tab" disabled title="Next pass">Sites</button>
      <button className="tab" disabled title="Next pass">Ledger</button>
    </nav>
  );
}

function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<Meta[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Meta[]>("/templates").then((xs) => {
      setList(xs);
      termDoc(
        [`templates (${xs.length})`, ...xs.map((t) => `  ${t.name}  v${t.version}`)].join("\n")
      );
    }, (e) => setError(e.message));
  }, []);

  const create = async () => {
    try {
      const { id } = await api<{ id: string }>("/templates", {
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
      <Tabs />
      {error && <p className="error">{error}</p>}
      {list?.map((t) => (
        <button key={t.id} className="card glass-frosted template-card" onClick={() => onOpen(t.id)}>
          <span className="template-name">{t.name}</span>
          <span className="version">v{t.version}</span>
        </button>
      ))}
      {list?.length === 0 && <p className="empty">No templates yet — start with your first one.</p>}
      <button className="big-btn primary" onClick={create}>+ New template</button>
    </div>
  );
}

function Editor({ id, onBack }: { id: string; onBack: () => void }) {
  const [tpl, setTpl] = useState<Loaded | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const dirty = useMemo(
    () => !!tpl && JSON.stringify({ name: tpl.name, tasks: tpl.tasks }) !== saved,
    [tpl, saved]
  );

  useEffect(() => {
    api<Loaded>(`/templates/${id}`).then((t) => {
      setTpl(t);
      setSaved(JSON.stringify({ name: t.name, tasks: t.tasks }));
    }, (e) => setError(e.message));
  }, [id]);

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
        { id: uid(), name: "New task", blocks: [], outcomes: [{ id: uid(), label: "DONE" }] },
      ],
    });

  const save = async () => {
    try {
      const body = { name: tpl.name, tasks: tpl.tasks };
      const { version } = await api<{ version: number }>(`/templates/${id}`, {
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
      await api(`/templates/${id}`, { method: "DELETE" });
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
        <button className="icon-btn" onClick={back} aria-label="Back">‹</button>
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
            <svg width="18" height="4" viewBox="0 0 18 4" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="2" r="1.8" />
              <circle cx="9" cy="2" r="1.8" />
              <circle cx="16" cy="2" r="1.8" />
            </svg>
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
        <div className="save-bar">
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
        { id: uid(), kind, label: { photo: "Photo", text: "Text", number: "Number" }[kind], unit: "" },
      ],
    }));

  const addOutcome = () =>
    patch((t) =>
      t.outcomes.length >= 6 ? t : { ...t, outcomes: [...t.outcomes, { id: uid(), label: "DONE" }] }
    );

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

      <p className="outcomes-label">Outcomes</p>
      <div className="outcomes-grid">
        {task.outcomes.map((b) => (
          <span key={b.id} className="outcome-btn">
            <input
              value={b.label}
              maxLength={60}
              onChange={(e) =>
                patch((t) => ({
                  ...t,
                  outcomes: t.outcomes.map((x) => (x.id === b.id ? { ...x, label: e.target.value } : x)),
                }))
              }
              aria-label="Outcome label"
            />
            {task.outcomes.length > 1 && (
              <button
                className="x"
                aria-label="Remove outcome"
                onClick={() => patch((t) => ({ ...t, outcomes: t.outcomes.filter((x) => x.id !== b.id) }))}
              >×</button>
            )}
          </span>
        ))}
      </div>

      <div className="add-row">
        <button onClick={() => addBlock("photo")}>+ Photo</button>
        <button onClick={() => addBlock("text")}>+ Text</button>
        <button onClick={() => addBlock("number")}>+ Number</button>
        <button onClick={addOutcome}>+ Outcome</button>
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
      <button className="icon-btn handle" aria-label="Drag to reorder" onPointerDown={onHandleDown}>⠿</button>
      <button className="icon-btn danger" aria-label="Remove" onClick={onRemove}>×</button>
    </span>
  );
}
