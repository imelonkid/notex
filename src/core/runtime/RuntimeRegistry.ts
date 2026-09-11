import type { LangId } from '../model';
import type { HostBridge } from '../../host/HostBridge';
import { type RuntimeChoice, readRuntimeChoices, updateRuntimeChoice } from '../config';
import { KernelSession } from './KernelSession';
import type { RuntimeCandidate, RuntimeInfo, RuntimeProvider, RuntimeStatus } from './types';

export interface LangState {
  lang: LangId;
  status: RuntimeStatus;
  /** 当前生效的运行时 */
  info?: RuntimeInfo;
  provider?: RuntimeProvider;
  session?: KernelSession;
  error?: string;
  /** 探测到的全部候选，设置里列给用户选 */
  candidates: RuntimeCandidate[];
  /** 用户明确选中的路径；没有就是「自动」 */
  selected?: string;
  /** 选择改了但内核还在用旧的跑：重启后才生效 */
  restartNeeded?: boolean;
  /** 正在跑的内核是用哪个路径启动的；和 info.path 不一致就是「重启后生效」 */
  launchedPath?: string;
}

const LANGS: LangId[] = ['java', 'python', 'js'];
const CACHE_KEY = 'nx.runtimes.v2';
const LEGACY_MANUAL_KEY = (lang: LangId) => `nx.runtime.path.${lang}`;
const LEGACY_CACHE_KEY = 'nx.runtimes.v1';

/** 内置运行时的路径特征，和 providers/isolation 保持一致 */
function isManaged(path: string, home: string): boolean {
  if (!home) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(path).startsWith(`${norm(home)}/.notex/runtimes/`);
}

/**
 * 管理每种语言的运行时：探测候选、按用户选择定下生效的那个、惰性启动、状态广播。
 * 一个笔记本对每种语言最多一个内核。
 */
export class RuntimeRegistry {
  private states = new Map<LangId, LangState>();
  private listeners = new Set<() => void>();
  private restartListeners = new Set<(lang: LangId) => void>();
  private launching = new Map<LangId, Promise<KernelSession | null>>();
  /** 内核的工作目录，即笔记库；打开笔记库后由界面层设置 */
  private workDir: string | undefined;
  private choices: Partial<Record<LangId, RuntimeChoice>> = {};
  private home = '';
  /** 配置只读一次；探测要等它读完，否则第一次会按「自动」选错 */
  private configLoaded: Promise<void> | null = null;

  constructor(
    private host: HostBridge,
    private providers: RuntimeProvider[],
  ) {
    for (const lang of LANGS) this.states.set(lang, { lang, status: 'unknown', candidates: [] });
    this.loadCache();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  /** 只影响之后启动的内核；已在跑的不换目录，免得用户手里的相对路径突然失效 */
  setWorkDir(dir: string | undefined) {
    this.workDir = dir || undefined;
  }

  /**
   * 内核重启或停止时通知外面。界面据此清掉这门语言的执行标记：
   * 新内核里什么都没跑过，装订线上的对号就不再成立。
   */
  onRestart(cb: (lang: LangId) => void): () => void {
    this.restartListeners.add(cb);
    return () => this.restartListeners.delete(cb);
  }

  get(lang: LangId): LangState {
    return this.states.get(lang) ?? { lang, status: 'unknown', candidates: [] };
  }

  all(): LangState[] {
    return [...this.states.values()];
  }

  providersFor(lang: LangId): RuntimeProvider[] {
    return this.providers.filter((p) => p.lang === lang).sort((a, b) => b.priority - a.priority);
  }

  /** 用户对这门语言的选择：选中路径与手动添加的路径 */
  choiceOf(lang: LangId): RuntimeChoice {
    return this.choices[lang] ?? {};
  }

  private patch(lang: LangId, next: Partial<LangState>) {
    const cur = this.get(lang);
    this.states.set(lang, { ...cur, ...next });
    this.emit();
  }

  // ---- 缓存与配置 ----

  /** 探测结果缓存到 localStorage，避免每次启动都跑一遍 exec */
  private loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as Record<string, { info?: RuntimeInfo; candidates?: RuntimeCandidate[] }>;
      for (const [lang, entry] of Object.entries(cached)) {
        const provider = entry.info && this.providers.find((p) => p.id === entry.info!.providerId);
        this.states.set(lang as LangId, {
          lang: lang as LangId,
          status: provider ? 'available' : 'unknown',
          info: provider ? entry.info : undefined,
          provider: provider || undefined,
          candidates: entry.candidates ?? [],
        });
      }
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  private saveCache() {
    const out: Record<string, { info?: RuntimeInfo; candidates: RuntimeCandidate[] }> = {};
    for (const s of this.states.values()) out[s.lang] = { info: s.info, candidates: s.candidates };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(out));
    } catch {
      /* 无痕模式等场景忽略 */
    }
  }

  private ensureConfig(): Promise<void> {
    if (!this.configLoaded) {
      this.configLoaded = (async () => {
        try {
          this.home = await this.host.homeDir();
        } catch {
          this.home = '';
        }
        try {
          this.choices = await readRuntimeChoices(this.host);
        } catch {
          this.choices = {};
        }
        await this.migrateLegacy();
        for (const lang of LANGS) this.patch(lang, { selected: this.choices[lang]?.selected });
      })();
    }
    return this.configLoaded;
  }

  /** 老版本把手动路径存在 localStorage：搬进 config.json，作为手动候选并选中 */
  private async migrateLegacy() {
    try {
      localStorage.removeItem(LEGACY_CACHE_KEY);
      for (const lang of LANGS) {
        const old = localStorage.getItem(LEGACY_MANUAL_KEY(lang));
        if (!old) continue;
        localStorage.removeItem(LEGACY_MANUAL_KEY(lang));
        if (!this.host.canSpawn) continue;
        this.choices[lang] = await updateRuntimeChoice(this.host, lang, (c) => ({
          selected: c.selected ?? old,
          custom: c.custom?.includes(old) ? c.custom : [...(c.custom ?? []), old],
        }));
      }
    } catch {
      /* 迁移失败不影响使用 */
    }
  }

  // ---- 探测与选择 ----

  /** 探测一种语言；force 为 true 时忽略缓存 */
  async detect(lang: LangId, force = false): Promise<LangState> {
    await this.ensureConfig();
    const cur = this.get(lang);
    if (!force && (cur.status === 'ready' || cur.status === 'busy' || cur.status === 'starting')) {
      return cur;
    }
    if (!force && cur.status === 'available' && cur.info) return cur;

    this.patch(lang, { status: 'detecting', error: undefined });
    const provider = this.providersFor(lang)[0];
    if (!provider) {
      this.patch(lang, { status: 'missing', candidates: [] });
      return this.get(lang);
    }
    let candidates: RuntimeCandidate[] = [];
    try {
      candidates = await provider.discover(this.host, this.choiceOf(lang).custom ?? []);
    } catch (e) {
      this.patch(lang, { status: 'missing', candidates: [], error: String((e as Error)?.message ?? e) });
      this.saveCache();
      return this.get(lang);
    }
    this.applyChoice(lang, provider, candidates);
    this.saveCache();
    return this.get(lang);
  }

  /**
   * 从候选里定下生效的那个：用户选过就用他选的；没选过按默认规则——
   * 有内置用内置，否则第一个可用的。选中的不可用时明确报错，不偷偷换一个。
   */
  private applyChoice(lang: LangId, provider: RuntimeProvider, candidates: RuntimeCandidate[]) {
    const selected = this.choiceOf(lang).selected;
    let chosen: RuntimeCandidate | undefined;
    let error: string | undefined;
    if (selected) {
      chosen = candidates.find((c) => c.path === selected);
      if (!chosen) error = `选中的运行时不存在：${selected}`;
      else if (!chosen.ok) {
        error = `选中的运行时不可用：${chosen.reason ?? '未知原因'}`;
        chosen = undefined;
      }
    } else {
      chosen =
        candidates.find((c) => c.ok && isManaged(c.path, this.home)) ?? candidates.find((c) => c.ok);
    }
    if (chosen) {
      const info: RuntimeInfo = {
        providerId: provider.id,
        version: chosen.version ?? 'unknown',
        path: chosen.path,
        source: chosen.source,
        managed: isManaged(chosen.path, this.home),
      };
      this.patch(lang, { status: 'available', info, provider, candidates, selected, error: undefined });
    } else {
      this.patch(lang, { status: 'missing', info: undefined, provider: undefined, candidates, selected, error });
    }
  }

  async detectAll(force = false): Promise<void> {
    await Promise.all(LANGS.map((l) => this.detect(l, force)));
  }

  /**
   * 用户选定一个路径（null 表示回到自动）。
   * 选择立刻写进配置并重算生效的运行时；内核还活着就标记「重启后生效」，绝不在运行中偷偷换。
   */
  async select(lang: LangId, path: string | null): Promise<void> {
    await this.ensureConfig();
    this.choices[lang] = await updateRuntimeChoice(this.host, lang, (c) => ({ ...c, selected: path ?? undefined }));
    const s = this.get(lang);
    const provider = s.provider ?? this.providersFor(lang)[0];
    if (provider && s.candidates.length && (!path || s.candidates.some((c) => c.path === path))) {
      this.applyChoice(lang, provider, s.candidates);
    } else {
      await this.detect(lang, true);
    }
    this.keepRunning(lang, s);
    this.saveCache();
  }

  /**
   * 重算生效运行时之后，若内核还活着就让它继续用旧的跑：
   * 状态别被 applyChoice 改成 available，并按「新选择是否等于启动时的路径」标记重启后生效。
   */
  private keepRunning(lang: LangId, before: LangState) {
    if (!before.session?.alive) return;
    const after = this.get(lang);
    this.patch(lang, {
      session: before.session,
      status: before.status,
      launchedPath: before.launchedPath,
      restartNeeded: !!after.info && after.info.path !== before.launchedPath,
    });
  }

  /** 手动添加一个路径：验证后进候选列表，并选中它 */
  async addCustomPath(lang: LangId, path: string): Promise<RuntimeCandidate | null> {
    await this.ensureConfig();
    const trimmed = path.trim();
    if (!trimmed) return null;
    this.choices[lang] = await updateRuntimeChoice(this.host, lang, (c) => ({
      ...c,
      custom: c.custom?.includes(trimmed) ? c.custom : [...(c.custom ?? []), trimmed],
    }));
    const prev = this.get(lang);
    await this.detect(lang, true);
    const found = this.get(lang).candidates.find((c) => c.path === trimmed) ?? null;
    if (found?.ok) await this.select(lang, trimmed);
    else this.keepRunning(lang, prev);
    return found;
  }

  /** 删掉一个手动添加的路径；正选着它就回到自动 */
  async removeCustomPath(lang: LangId, path: string): Promise<void> {
    await this.ensureConfig();
    this.choices[lang] = await updateRuntimeChoice(this.host, lang, (c) => ({
      selected: c.selected === path ? undefined : c.selected,
      custom: (c.custom ?? []).filter((p) => p !== path),
    }));
    const prev = this.get(lang);
    await this.detect(lang, true);
    this.keepRunning(lang, prev);
  }

  // ---- 内核生命周期 ----

  /** 拿到就绪的内核会话；未探测则先探测，未启动则启动。缺失环境返回 null。 */
  async ensure(lang: LangId): Promise<KernelSession | null> {
    const existing = this.get(lang);
    if (existing.session?.alive) return existing.session;

    const inFlight = this.launching.get(lang);
    if (inFlight) return inFlight;

    const task = (async (): Promise<KernelSession | null> => {
      let state = this.get(lang);
      // 上次启动失败也要重探：失败的原因常常就是路径变了，
      // 只对 unknown/missing 重探的话会一直拿着失效的路径撞墙
      if (state.status === 'unknown' || state.status === 'missing' || state.status === 'error') {
        state = await this.detect(lang, state.status !== 'unknown');
      }
      if (!state.info || !state.provider) return null;

      // 缓存来自 localStorage，路径可能早已不存在（卸载、换了版本管理器）。
      // 启动前核对一次，没了就重探，而不是把"文件不存在"当成启动失败报给用户
      const stillThere = await this.host.fileExists(state.info.path).catch(() => true);
      if (!stillThere) {
        state = await this.detect(lang, true);
        if (!state.info || !state.provider) return null;
      }

      this.patch(lang, { status: 'starting', error: undefined, restartNeeded: false });
      try {
        const conn = await state.provider.launch(this.host, state.info, { cwd: this.workDir, home: this.home });
        const session = new KernelSession(conn, state.provider.id, state.info.version, state.provider.interrupt);
        session.onExit(() => {
          const s = this.get(lang);
          if (s.session === session) {
            this.patch(lang, { status: 'available', session: undefined });
          }
        });
        this.patch(lang, { status: 'ready', session, launchedPath: state.info.path });
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

  /** 停掉内核但不重启。释放资源、清掉状态，下次运行时再惰性启动 */
  async stop(lang: LangId): Promise<void> {
    const s = this.get(lang);
    if (!s.session) return;
    await s.session.dispose();
    this.patch(lang, { session: undefined, status: s.info ? 'available' : 'unknown', restartNeeded: false });
    // 内核没了，装订线上"跑过"的标记也就不成立了，和重启一样要清
    this.restartListeners.forEach((cb) => cb(lang));
  }

  async restart(lang: LangId): Promise<KernelSession | null> {
    const s = this.get(lang);
    if (s.session) await s.session.dispose();
    this.patch(lang, { session: undefined, status: s.info ? 'available' : 'unknown', restartNeeded: false });
    this.restartListeners.forEach((cb) => cb(lang));
    return this.ensure(lang);
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.session?.dispose()));
  }
}
