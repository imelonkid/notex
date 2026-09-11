import { debug } from '@core/debug';

/**
 * 写剪贴板。
 *
 * 优先用异步 Clipboard API；它在部分 webview 里拿不到权限，
 * 所以留一条 execCommand 的退路——这条路要求元素真的在页面上且被选中，
 * 因此用移出视口的方式藏，不能用 display:none。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      debug.log('clipboard', '写入成功（Clipboard API）', { chars: text.length });
      return true;
    }
    debug.warn('clipboard', 'Clipboard API 不可用，改用 execCommand');
  } catch (e) {
    debug.warn('clipboard', 'Clipboard API 写入失败，改用 execCommand', e);
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    debug.log('clipboard', ok ? '写入成功（execCommand）' : '写入失败（execCommand 返回 false）', {
      chars: text.length,
    });
    return ok;
  } catch (e) {
    debug.error('clipboard', '写入失败', e);
    return false;
  }
}
