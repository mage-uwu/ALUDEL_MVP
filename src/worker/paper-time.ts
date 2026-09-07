const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

/** Interpret local paperwork times in its declared zone; reject impossible wall times. */
export function paperTime(date: unknown, clock: unknown, timezone: string): string | null {
  const raw = text(date);
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = Date.parse(raw); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(.+))?$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(.+))?$/.exec(raw);
  if (!us && !iso) return null;
  const [y, m, d] = us ? [+us[3]!, +us[1]!, +us[2]!] : [+iso![1]!, +iso![2]!, +iso![3]!];
  const time = text(clock) || (us ?? iso)![4] || "12:00";
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(time);
  if (!t) return null;
  let h = +t[1]!;
  const minute = +t[2]!, second = +(t[3] ?? 0);
  if (minute > 59 || second > 59 || h > (t[4] ? 12 : 23) || (t[4] && h < 1)) return null;
  if (t[4]) h = h % 12 + (/pm/i.test(t[4]) ? 12 : 0);
  const wall = Date.UTC(y!, m! - 1, d!, h, minute, second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m! - 1 || check.getUTCDate() !== d) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const local = (stamp: number) => {
    const p = Object.fromEntries(fmt.formatToParts(stamp).map(x => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  };
  let guess = wall;
  for (let i = 0; i < 3; i++) guess += wall - local(guess);
  return local(guess) === wall ? new Date(guess).toISOString() : null;
}
