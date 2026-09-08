import type { LangId } from '../model';
import type { HostBridge } from '../../host/HostBridge';
import { KernelSession } from './KernelSession';
import type { RuntimeInfo, RuntimeProvider, RuntimeStatus } from './types';

export interface LangState {
  lang: LangId;
  status: RuntimeStatus;
  /** 探测到的可用 provider，按优先级排序 */
  info?: RuntimeInfo;
  provider?: RuntimeProvider;
  session?: KernelSession;
  error?: string;
}

const CACHE_KEY = 'xnb.runtimes.v1';

/**
 * 管理每种语言的运行时：探测、惰性启动、状态广播。
 * 一个笔记本对每种语言最多一个内核。
 */
export class RuntimeRegistry {
  private states = new Map<LangId, LangState>();
  private listeners = new Set<() => void>();
  private launching = new Map<LangId, Promise<KernelSession | null>>();

  constructor(
    private host: HostBridge,
    private providers: RuntimeProvider[],
  ) {
    for (const lang of ['java', 'python', 'js'] as LangId[]) {
      this.states.set(lang, { lang, status: 'unknown' });
    }
    this.loadCache();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  get(lang: LangId): LangState {
    return this.states.get(lang) ?? { lang, status: 'unknown' };
  }

  all(): LangState[] {
    return [...this.states.values()];
  }

  providersFor(lang: LangId): RuntimeProvider[] {
    return this.providers.filter((p) => p.lang === lang).sort((a, b) => b.priority - a.priority);
  }

  private patch(lang: LangId, next: Partial<LangState>) {
    const cur = this.get(lang);
    this.states.set(lang, { ...cur, ...next });
    this.emit();
  }

  /** 探测结果缓存到 localStorage，避免每次启动都跑一遍 exec */
  private loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as Record<string, RuntimeInfo>;
      for (const [lang, info] of Object.entries(cached)) {
        const provider = this.providers.find((p) => p.id === info.providerId);
        if (!provider) continue;
        this.states.set(lang as LangId, {
          lang: lang as LangId,
          status: 'available',
          info,
          provider,
        });
      }
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  private saveCache() {
    const out: Record<string, RuntimeInfo> = {};
    for (const s of this.states.values()) if (s.info) out[s.lang] = s.info;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch {
      /* 无痕模式等场景忽略 */
    }
  }

  /** 探测一种语言；force 为 true 时忽略缓存 */
  async detect(lang: LangId, force = false): Promise<LangState> {
    const cur = this.get(lang);
    if (!force && (cur.status === 'ready' || cur.status === 'busy' || cur.status === 'starting')) {
      return cur;
    }
    if (!force && cur.status === 'available' && cur.info) return cur;

    this.patch(lang, { status: 'detecting', error: undefined });
    for (const provider of this.providersFor(lang)) {
      try {
        const info = await provider.detect(this.host);
        if (info) {
          this.patch(lang, { status: 'available', info, provider, error: undefined });
          this.saveCache();
          return this.get(lang);
        }
      } catch (e) {
        // 单个 provider 探测失败不影响其它 provider
        console.warn(`[xnotebook] ${provider.id} 探测失败`, e);
      }
    }
    this.patch(lang, { status: 'missing', info: undefined, provider: undefined });
    this.saveCache();
    return this.get(lang);
  }

  async detectAll(force = false): Promise<void> {
    await Promise.all((['java', 'python', 'js'] as LangId[]).map((l) => this.detect(l, force)));
  }

  /** 拿到就绪的内核会话；未探测则先探测，未启动则启动。缺失环境返回 null。 */
  async ensure(lang: LangId): Promise<KernelSession | null> {
    const existing = this.get(lang);
    if (existing.session?.alive) return existing.session;

    const inFlight = this.launching.get(lang);
    if (inFlight) return inFlight;

    const task = (async (): Promise<KernelSession | null> => {
      let state = this.get(lang);
      if (state.status === 'unknown' || state.status === 'missing') {
        state = await this.detect(lang, state.status === 'missing');
      }
      if (!state.info || !state.provider) return null;

      this.patch(lang, { status: 'starting', error: undefined });
      try {
        const conn = await state.provider.launch(this.host, state.info);
        const session = new KernelSession(conn, state.provider.id, state.info.version);
        session.onExit(() => {
          const s = this.get(lang);
          if (s.session === session) {
            this.patch(lang, { status: 'available', session: undefined });
          }
        });
        this.patch(lang, { status: 'ready', session });
        return session;
      } catch (e) {
        this.patch(lang, { status: 'error', error: String((e as Error)?.message ?? e) });
        return null;
      }
    })();

    this.launching.set(lang, task);
    try {
      return await task;
    } finally {
      this.launching.delete(lang);
    }
  }

  /** 用户聚焦某语言 cell 时预热，掩盖 JVM 冷启动 */
  prewarm(lang: LangId): void {
    const s = this.get(lang);
    if (s.session?.alive || s.status === 'starting' || s.status === 'missing') return;
    void this.ensure(lang);
  }

  setBusy(lang: LangId, busy: boolean) {
    const s = this.get(lang);
    if (!s.session?.alive) return;
    this.patch(lang, { status: busy ? 'busy' : 'ready' });
  }

  async restart(lang: LangId): Promise<KernelSession | null> {
    const s = this.get(lang);
    if (s.session) await s.session.dispose();
    this.patch(lang, { session: undefined, status: s.info ? 'available' : 'unknown' });
    return this.ensure(lang);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.session?.dispose()));
  }

  /** 用户手动指定可执行文件路径 */
  setManualPath(lang: LangId, path: string | null) {
    const key = `xnb.runtime.path.${lang}`;
    if (path) localStorage.setItem(key, path);
    else localStorage.removeItem(key);
  }

  getManualPath(lang: LangId): string {
    return localStorage.getItem(`xnb.runtime.path.${lang}`) ?? '';
  }
}
