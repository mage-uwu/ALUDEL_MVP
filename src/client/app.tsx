import { useEffect, useMemo, useRef, useState } from "react";
import {
  EVERY_WEEKS,
  WINDOW_DAYS,
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
  termLog(`$ ${init?.method ?? "GET"} /api${path} → ${res.status}`);
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
      `  task "${k.name}"  every ${k.everyWeeks}w · within ${k.windowDays}d`,
      ...k.blocks.map((b) => `    ${b.kind.padEnd(6)} "${b.label}"${b.unit ? `  (${b.unit})` : ""}`),
      `    ends → ${k.endsWith.map((e) => `[${e.label.toUpperCase() || "?"}]`).join("  ")}`,
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
const move = <T,>(xs: T[], i: number, dir: -1 | 1): T[] => {
  const j = i + dir;
  if (j < 0 || j >= xs.length) return xs;
  const out = [...xs];
  out.splice(j, 0, ...out.splice(i, 1));
  return out;
};

export default function App() {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="layout">
      <Terminal />
      <main className="pane">
        {openId ? <Editor id={openId} onBack={() => setOpenId(null)} /> : <Home onOpen={setOpenId} />}
      </main>
    </div>
  );
}

function Tabs() {
  return (
    <nav className="tabs">
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
        <button key={t.id} className="card template-card" onClick={() => onOpen(t.id)}>
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

  if (!tpl) return <div className="shell">{error ? <p className="error">{error}</p> : <p className="empty">Loading…</p>}</div>;

  const patchTask = (taskId: string, fn: (t: Task) => Task) =>
    setTpl({ ...tpl, tasks: tpl.tasks.map((t) => (t.id === taskId ? fn(t) : t)) });

  const addTask = () =>
    setTpl({
      ...tpl,
      tasks: [
        ...tpl.tasks,
        { id: uid(), name: "New task", everyWeeks: 3, windowDays: 5, blocks: [], endsWith: [{ id: uid(), label: "DONE" }] },
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
        <span className="version">v{tpl.version}</span>
        <button className="icon-btn danger" onClick={remove} aria-label="Delete template">🗑</button>
      </header>
      <input
        className="title-input"
        value={tpl.name}
        maxLength={80}
        onChange={(e) => setTpl({ ...tpl, name: e.target.value })}
        aria-label="Template name"
      />
      {error && <p className="error">{error}</p>}
      {tpl.tasks.map((task, i) => (
        <TaskCard
          key={task.id}
          task={task}
          patch={(fn) => patchTask(task.id, fn)}
          onMove={(dir) => setTpl({ ...tpl, tasks: move(tpl.tasks, i, dir) })}
          onRemove={() => setTpl({ ...tpl, tasks: tpl.tasks.filter((t) => t.id !== task.id) })}
        />
      ))}
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
  patch,
  onMove,
  onRemove,
}: {
  task: Task;
  patch: (fn: (t: Task) => Task) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const addBlock = (kind: BlockKind) =>
    patch((t) => ({
      ...t,
      blocks: [
        ...t.blocks,
        { id: uid(), kind, label: { photo: "Photo", text: "Text", number: "Number" }[kind], unit: "" },
      ],
    }));

  const addButton = () =>
    patch((t) =>
      t.endsWith.length >= 6 ? t : { ...t, endsWith: [...t.endsWith, { id: uid(), label: "DONE" }] }
    );

  return (
    <section className="card task">
      <div className="task-head">
        <input
          className="task-name"
          value={task.name}
          maxLength={80}
          onChange={(e) => patch((t) => ({ ...t, name: e.target.value }))}
          aria-label="Task name"
        />
        <RowControls onMove={onMove} onRemove={onRemove} />
      </div>
      <div className="cadence">
        <select
          value={task.everyWeeks}
          onChange={(e) => patch((t) => ({ ...t, everyWeeks: Number(e.target.value) as Task["everyWeeks"] }))}
          aria-label="Repeat cadence"
        >
          {EVERY_WEEKS.map((w) => (
            <option key={w} value={w}>{w === 1 ? "Every week" : `Every ${w} weeks`}</option>
          ))}
        </select>
        <span>,</span>
        <select
          value={task.windowDays}
          onChange={(e) => patch((t) => ({ ...t, windowDays: Number(e.target.value) as Task["windowDays"] }))}
          aria-label="Completion window"
        >
          {WINDOW_DAYS.map((d) => (
            <option key={d} value={d}>{d === 1 ? "complete within 1 day" : `complete within ${d} days`}</option>
          ))}
        </select>
      </div>

      {task.blocks.map((block, i) => (
        <BlockRow
          key={block.id}
          block={block}
          onChange={(b) => patch((t) => ({ ...t, blocks: t.blocks.map((x) => (x.id === b.id ? b : x)) }))}
          onMove={(dir) => patch((t) => ({ ...t, blocks: move(t.blocks, i, dir) }))}
          onRemove={() => patch((t) => ({ ...t, blocks: t.blocks.filter((x) => x.id !== block.id) }))}
        />
      ))}

      <p className="ends-label">Ends with</p>
      <div className="ends-grid">
        {task.endsWith.map((b) => (
          <span key={b.id} className="end-btn">
            <input
              value={b.label}
              maxLength={60}
              onChange={(e) =>
                patch((t) => ({
                  ...t,
                  endsWith: t.endsWith.map((x) => (x.id === b.id ? { ...x, label: e.target.value } : x)),
                }))
              }
              aria-label="Button label"
            />
            {task.endsWith.length > 1 && (
              <button
                className="x"
                aria-label="Remove button"
                onClick={() => patch((t) => ({ ...t, endsWith: t.endsWith.filter((x) => x.id !== b.id) }))}
              >×</button>
            )}
          </span>
        ))}
      </div>

      <div className="add-row">
        <button onClick={() => addBlock("photo")}>+ Photo</button>
        <button onClick={() => addBlock("text")}>+ Text</button>
        <button onClick={() => addBlock("number")}>+ Number</button>
        <button onClick={addButton}>+ Button</button>
      </div>
    </section>
  );
}

function BlockRow({
  block,
  onChange,
  onMove,
  onRemove,
}: {
  block: Block;
  onChange: (b: Block) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="block">
      <div className="block-head">
        <input
          className="block-label"
          value={block.label}
          maxLength={60}
          onChange={(e) => onChange({ ...block, label: e.target.value })}
          aria-label="Block label"
        />
        <RowControls onMove={onMove} onRemove={onRemove} />
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

function RowControls({ onMove, onRemove }: { onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="row-controls">
      <button className="icon-btn" aria-label="Move up" onClick={() => onMove(-1)}>↑</button>
      <button className="icon-btn" aria-label="Move down" onClick={() => onMove(1)}>↓</button>
      <button className="icon-btn danger" aria-label="Remove" onClick={onRemove}>×</button>
    </span>
  );
}
