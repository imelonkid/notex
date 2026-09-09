import type { Notebook } from '../model';

/** 列表里的一条，不含 cell 内容，避免为了画侧栏读全部文件 */
export interface NotebookRef {
  /** 相对笔记库根的路径，不含扩展名，例如 "工作/周报" */
  id: string;
  /** 文件名部分，侧栏显示用 */
  title: string;
  /** 所在目录，根目录为空串 */
  dir: string;
  updated?: string;
}

export interface VaultListing {
  notes: NotebookRef[];
  /** 所有目录，含空目录 */
  folders: string[];
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
  create(title: string, dir?: string): Promise<Notebook>;
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

  /** 以下只有落盘的实现支持，localStorage 后端没有目录概念 */
  listAll?(): Promise<VaultListing>;
  readRaw?(id: string): Promise<string>;
  move?(id: string, targetDir: string): Promise<string>;
  createFolder?(dir: string): Promise<void>;
  removeFolder?(dir: string): Promise<void>;
}
