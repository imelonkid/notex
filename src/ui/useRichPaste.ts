import { useCallback, useMemo } from 'react';
import { assetNameForBlob, assetNameForUrl, assetRelPath, ASSETS_DIR, extOfMime } from '@core/assets';
import { debug } from '@core/debug';
import { fetchToFile } from '@core/net';
import { findImageRefs, htmlToMarkdown, replaceImageSrc, sourceUrlOf } from '@core/paste';
import { dirOf } from '@core/store/paths';
import type { HostBridge } from '@host/HostBridge';

export interface ClipboardPayload {
  html?: string;
  text?: string;
  files: File[];
}

interface Options {
  host: HostBridge;
  /** 笔记库根目录；纯浏览器模式没有，图片只能保留原地址 */
  vaultPath: string | null;
  noteId: string | null;
  notify(text: string): void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

/**
 * 富文本粘贴：HTML 转 Markdown，图片落到笔记同目录的 .assets/，正文里改成相对路径。
 * 也处理直接粘贴的图片文件（截图）。返回要插进编辑器的 Markdown；
 * 返回 null 表示这次粘贴没什么可接管的，让浏览器按纯文本走。
 *
 * 正文里相对路径的图片要能显示，还得配合 resolveImage 把它换成宿主能加载的地址。
 */
export function useRichPaste({ host, vaultPath, noteId, notify }: Options) {
  const noteDir = useMemo(() => {
    if (!vaultPath || !noteId) return null;
    return host.joinPath(vaultPath, ...dirOf(noteId).split('/').filter(Boolean));
  }, [host, vaultPath, noteId]);

  const assetPath = useCallback((name: string) => (noteDir ? host.joinPath(noteDir, ASSETS_DIR, name) : null), [host, noteDir]);

  /** 把一张远程或 data: 图片存进 .assets；成功返回相对路径 */
  const localize = useCallback(
    async (src: string): Promise<string | null> => {
      if (!noteDir) return null;
      if (src.startsWith('data:')) {
        const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(src);
        if (!m) return null;
        const name = assetNameForBlob(m[1], src.slice(0, 4096), `image.${extOfMime(m[1])}`);
        const dest = assetPath(name)!;
        if (!(await host.fileExists(dest))) await host.writeBinary(dest, m[2]);
        return assetRelPath(name);
      }
      const name = assetNameForUrl(src);
      const dest = assetPath(name)!;
      if (await host.fileExists(dest)) return assetRelPath(name);
      await host.ensureDir(host.joinPath(noteDir, ASSETS_DIR));
      const res = await fetchToFile(host, src, dest);
      if (!res.ok) {
        debug.warn('paste', '图片下载失败，保留原地址', { src, error: res.error });
        await host.removeFile(dest).catch(() => undefined);
        return null;
      }
      return assetRelPath(name);
    },
    [host, noteDir, assetPath],
  );

  const importClipboard = useCallback(
    async (payload: ClipboardPayload): Promise<string | null> => {
      const images = payload.files.filter((f) => f.type.startsWith('image/'));

      // 直接粘图片文件：截图、从访达拖来的图
      if (images.length) {
        if (!noteDir) {
          notify('当前存在浏览器里，无法保存图片');
          return null;
        }
        const lines: string[] = [];
        for (const file of images) {
          const name = assetNameForBlob(file.type, `${file.name}-${file.size}-${file.lastModified}`, file.name || undefined);
          const dest = assetPath(name)!;
          if (!(await host.fileExists(dest))) await host.writeBinary(dest, await fileToBase64(file));
          lines.push(`![${file.name.replace(/\.[^.]+$/, '') || '图片'}](${assetRelPath(name)})`);
        }
        debug.log('paste', '粘贴图片文件', { count: lines.length });
        return lines.join('\n\n');
      }

      const html = payload.html?.trim();
      if (!html) return null;
      let md = htmlToMarkdown(html, sourceUrlOf(html));
      if (!md) return null;

      const refs = findImageRefs(md);
      let saved = 0;
      let failed = 0;
      for (const ref of refs) {
        try {
          const rel = await localize(ref.src);
          if (rel) {
            md = replaceImageSrc(md, ref.src, rel);
            saved += 1;
          } else if (noteDir) failed += 1;
        } catch (e) {
          failed += 1;
          debug.warn('paste', '图片落地失败', { src: ref.src, error: String((e as Error)?.message ?? e) });
        }
      }
      debug.log('paste', '粘贴富文本', { chars: md.length, images: refs.length, saved, failed });
      if (refs.length && noteDir) {
        notify(
          failed
            ? `已转成 Markdown，${saved} 张图片存入 .assets，${failed} 张下载失败，保留了原地址`
            : `已转成 Markdown，${saved} 张图片存入 .assets`,
        );
      } else if (refs.length) {
        notify('已转成 Markdown；纯浏览器模式下图片保留原地址');
      }
      return md;
    },
    [host, noteDir, assetPath, localize, notify],
  );

  /** 正文里相对路径的图片换成宿主能加载的地址；绝对地址原样 */
  const resolveImage = useCallback(
    (src: string): string => {
      if (!noteDir || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/__host\/)/i.test(src)) return src;
      const clean = decodeURIComponent(src.split(/[?#]/)[0]);
      return host.fileUrl(host.joinPath(noteDir, ...clean.split('/').filter((s) => s && s !== '.')));
    },
    [host, noteDir],
  );

  return { importClipboard, resolveImage };
}
