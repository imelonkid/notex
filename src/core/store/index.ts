import type { HostBridge } from '../../host/HostBridge';
import { resolveVault } from '../config';
import { LocalStore } from './LocalStore';
import { VaultStore } from './VaultStore';
import type { NotebookStore } from './types';

export type { NotebookRef, NotebookStore } from './types';
export { VaultStore } from './VaultStore';
export { LocalStore } from './LocalStore';

const MIGRATED_KEY = 'nx.vault.migrated';

/**
 * 首次接上 vault 时，把 localStorage 里的老笔记写进去。
 * 只做一次，且不覆盖 vault 里的同名文件（uniqueId 会加序号）。
 */
async function migrateFromLocal(vault: VaultStore): Promise<number> {
  if (localStorage.getItem(MIGRATED_KEY) === '1') return 0;
  // 先置位再迁移：中途失败也不该在下次启动时重复写入
  localStorage.setItem(MIGRATED_KEY, '1');
  const local = new LocalStore();
  if (!local.hasData()) return 0;
  let count = 0;
  for (const nb of local.allNotebooks()) {
    try {
      await vault.adopt(nb);
      count += 1;
    } catch (e) {
      console.warn('[NoteX] 迁移笔记失败', nb.title, e);
    }
  }
  return count;
}

export interface StoreSetup {
  store: NotebookStore;
  /** vault 路径；本地存储模式下为空 */
  vaultPath: string;
  isDefaultVault: boolean;
  migrated: number;
  /** 宿主不支持文件时的原因，用于在界面上解释 */
  fallbackReason?: string;
}

// React 严格模式会重复触发副作用，同一次打开必须共享同一个 promise，
// 否则建目录与迁移会跑两遍
let inFlight: Promise<StoreSetup> | null = null;

/** 能落盘就用 vault，否则退回 localStorage */
export function openStore(host: HostBridge): Promise<StoreSetup> {
  if (!inFlight) {
    inFlight = doOpenStore(host).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doOpenStore(host: HostBridge): Promise<StoreSetup> {
  try {
    const { path, isDefault } = await resolveVault(host);
    const vault = new VaultStore(host, path);
    await vault.init();
    const migrated = await migrateFromLocal(vault);
    return { store: vault, vaultPath: path, isDefaultVault: isDefault, migrated };
  } catch (e) {
    return {
      store: new LocalStore(),
      vaultPath: '',
      isDefaultVault: true,
      migrated: 0,
      fallbackReason: String((e as Error)?.message ?? e),
    };
  }
}
