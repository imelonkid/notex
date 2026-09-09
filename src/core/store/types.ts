import type { Notebook } from '../model';

/** 列表里的一条，不含 cell 内容，避免为了画侧栏读全部文件 */
export interface NotebookRef {
  id: string;
  title: string;
  updated?: string;
}

/**
 * 笔记存储后端。目前有两种实现：
 * - VaultStore：落到磁盘目录，Markdown 为正本
 * - LocalStore：存 localStorage，纯浏览器模式下的兜底
 */
export interface NotebookStore {
  readonly kind: 'vault' | 'local';
  /** 展示给用户的位置描述 */
  readonly location: string;

  list(): Promise<NotebookRef[]>;
  load(id: string): Promise<Notebook | null>;
  save(nb: Notebook): Promise<void>;
  create(title: string): Promise<Notebook>;
  remove(id: string): Promise<void>;
  /**
   * 改标题。vault 里这会连带重命名文件，因此 id 可能变化，
   * 返回新的 id 供调用方更新选中项。
   */
  retitle(id: string, title: string): Promise<string>;

  /**
   * 文件是否在应用之外被改过。只有落盘的实现需要，
   * localStorage 后端不存在这个问题。
   */
  changedOutside?(id: string): Promise<boolean>;
}
