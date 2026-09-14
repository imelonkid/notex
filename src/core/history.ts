/**
 * 撤销栈：快照式，带「会话合并」。
 *
 * 结构操作（删除、移动、转换 cell）一步一条；文字编辑按会话合并——
 * 在同一个 cell 里连续敲的字只记一条，切到别的 cell 或退出编辑就封口。
 * 编辑器内的 ⌘Z 仍由编辑器逐字撤销，编辑器外的 ⌘Z 撤销整段会话。
 *
 * 只存快照不存补丁：笔记就几十个 cell，一个快照几十 KB，一百条也就几 MB，
 * 换来的是撤销逻辑不可能算错。
 */

export interface HistoryEntry<T> {
  /** 这一步之前的样子 */
  before: T;
  /** 会话合并的键，通常是 cell id；结构操作没有 */
  group?: string;
}

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: T[] = [];
  /** 最近一条是否还开着口，后续同组的改动并进去 */
  private open: string | null = null;

  /**
   * equals 用来跳过"净变化为零"的条目：在编辑器里敲了又用编辑器自己的 ⌘Z 删掉，
   * 会话记了一条但前后一样，撤销它什么都不会发生，用户只会觉得按键失灵。
   */
  constructor(
    private readonly max = 100,
    private readonly equals: (a: T, b: T) => boolean = (a, b) => a === b,
  ) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  /** 最近一条编辑会话是否还开着口 */
  get isOpen(): boolean {
    return this.open !== null;
  }

  /**
   * 记一步。group 相同且上一条还开着口就并入上一条（before 保持不变）；
   * 任何一次新记录都清空重做栈。
   */
  record(before: T, group?: string): void {
    if (group && this.open === group && this.past.length) return;
    this.past.push({ before, group });
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
    this.open = group ?? null;
  }

  /** 会话封口：下一次同组改动另起一条 */
  seal(): void {
    this.open = null;
  }

  /** 撤销：返回该恢复的快照；current 是现在的样子，进重做栈。前后一样的条目直接跳过 */
  undo(current: T): T | null {
    this.open = null;
    for (;;) {
      const entry = this.past.pop();
      if (!entry) return null;
      if (this.equals(entry.before, current)) continue;
      this.future.push(current);
      return entry.before;
    }
  }

  /** 重做：返回该恢复的快照；current 进撤销栈 */
  redo(current: T): T | null {
    this.open = null;
    for (;;) {
      const next = this.future.pop();
      if (next === undefined) return null;
      if (this.equals(next, current)) continue;
      this.past.push({ before: current });
      return next;
    }
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.open = null;
  }
}
