/**
 * 列表页的时间写法：近的写相对时间，远的写日期。
 * 纯函数，now 可以传进来，方便测试。
 */

const pad = (n: number) => String(n).padStart(2, '0');

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 按本地日期算差几天，跨夏令时也不会差出半天 */
function daysBetween(earlier: Date, later: Date): number {
  const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime();
  const b = new Date(later.getFullYear(), later.getMonth(), later.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function dateOnly(d: Date, now: Date): string {
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
    : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 列表每一行：刚刚、N 分钟前、今天 10:32、昨天 21:08、9 月 8 日 */
export function formatUpdated(iso: string | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return '';
  const diff = now.getTime() - d.getTime();
  if (diff >= 0 && diff < 60_000) return '刚刚';
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const days = daysBetween(d, now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  return dateOnly(d, now);
}

/** 只到天：标题下面那句「最近更新于今天」用 */
export function formatDay(iso: string | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return '';
  const days = daysBetween(d, now);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return dateOnly(d, now);
}
