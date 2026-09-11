/**
 * localStorage 里的工作区。只在纯浏览器模式下作为兜底，
 * 也是接上 vault 之前老数据的来源（见 store/index.ts 的迁移）。
 */
import type { Notebook, Workspace } from './model';
import { WELCOME_TITLE, welcomeCells } from './welcome';

const KEY = 'notex.workspace.v1';

function seed(): Workspace {
  const nb: Notebook = {
    id: 'nb-welcome',
    title: WELCOME_TITLE,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    cells: welcomeCells(),
  };
  return { activeId: nb.id, notebooks: [nb] };
}

/**
 * localStorage 里是否真的存过工作区。
 * loadWorkspace 在没有数据时会返回种子，迁移必须区分这两种情况，
 * 否则新装的客户端会把种子笔记写进 vault。
 */
export function hasStoredWorkspace(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Workspace;
      if (parsed?.notebooks?.length) return parsed;
    }
  } catch {
    /* 坏数据就重新播种 */
  }
  return seed();
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ws));
  } catch {
    /* 配额满或无痕模式，静默失败 */
  }
}
