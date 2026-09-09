import type { HostBridge } from '../host/HostBridge';

export interface AppConfig {
  /** 笔记库目录。未设置时用 ~/NoteX */
  vault?: string;
}

const CONFIG_DIR = '.notex';
const CONFIG_FILE = 'config.json';
const DEFAULT_VAULT_NAME = 'NoteX';

/**
 * 配置存在 ~/.notex/config.json，而不是 localStorage。
 * 这样开发服务器和桌面壳看到的是同一份设置。
 */
export async function configPath(host: HostBridge): Promise<string> {
  return host.joinPath(await host.homeDir(), CONFIG_DIR, CONFIG_FILE);
}

export async function defaultVault(host: HostBridge): Promise<string> {
  return host.joinPath(await host.homeDir(), DEFAULT_VAULT_NAME);
}

export async function readConfig(host: HostBridge): Promise<AppConfig> {
  try {
    const path = await configPath(host);
    // 先探测存在与否，省掉一次注定失败的读取
    if (!(await host.fileExists(path))) return {};
    const raw = await host.readText(path);
    const parsed = JSON.parse(raw) as AppConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 没有配置文件是正常情况，走默认值
    return {};
  }
}

export async function writeConfig(host: HostBridge, config: AppConfig): Promise<void> {
  await host.writeText(await configPath(host), JSON.stringify(config, null, 2) + '\n');
}

/** 当前生效的 vault 路径；未配置则返回默认值 */
export async function resolveVault(host: HostBridge): Promise<{ path: string; isDefault: boolean }> {
  const config = await readConfig(host);
  const configured = config.vault?.trim();
  if (configured) return { path: configured, isDefault: false };
  return { path: await defaultVault(host), isDefault: true };
}

export async function setVault(host: HostBridge, vault: string | null): Promise<void> {
  const config = await readConfig(host);
  if (vault && vault.trim()) config.vault = vault.trim();
  else delete config.vault;
  await writeConfig(host, config);
}
