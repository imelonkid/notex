import { type Notebook, type Workspace, newNotebook } from '../model';
import { hasStoredWorkspace, loadWorkspace, saveWorkspace } from '../store';
import type { NotebookRef, NotebookStore } from './types';

/**
 * localStorage 后端。纯浏览器模式下的兜底，
 * 也是接上 vault 之前的老数据来源，迁移时会读它。
 */
export class LocalStore implements NotebookStore {
  readonly kind = 'local';
  readonly location = '浏览器本地存储';

  private ws: Workspace = loadWorkspace();

  private persist() {
    saveWorkspace(this.ws);
  }

  async list(): Promise<NotebookRef[]> {
    return this.ws.notebooks.map((n) => ({ id: n.id, title: n.title, updated: n.updated }));
  }

  async load(id: string): Promise<Notebook | null> {
    return this.ws.notebooks.find((n) => n.id === id) ?? null;
  }

  async save(nb: Notebook): Promise<void> {
    const i = this.ws.notebooks.findIndex((n) => n.id === nb.id);
    if (i >= 0) this.ws.notebooks[i] = nb;
    else this.ws.notebooks.push(nb);
    this.persist();
  }

  async create(title: string): Promise<Notebook> {
    const nb = newNotebook(title);
    this.ws.notebooks.push(nb);
    this.ws.activeId = nb.id;
    this.persist();
    return nb;
  }

  async remove(id: string): Promise<void> {
    this.ws.notebooks = this.ws.notebooks.filter((n) => n.id !== id);
    this.persist();
  }

  async retitle(id: string, title: string): Promise<string> {
    const nb = this.ws.notebooks.find((n) => n.id === id);
    if (nb) {
      nb.title = title;
      this.persist();
    }
    return id;
  }

  /** 迁移用：拿到全部笔记 */
  allNotebooks(): Notebook[] {
    return this.ws.notebooks;
  }

  /** 真的存过数据，而不是 loadWorkspace 兜底给出的种子 */
  hasData(): boolean {
    return hasStoredWorkspace() && this.ws.notebooks.length > 0;
  }
}
