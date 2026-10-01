import { useEffect, useState } from "react";

/**
 * 是否处于窄屏视口。
 *
 * 用于让少数页面在手机上换一种**布局结构**，而不只是把桌面版压窄 ——
 * 例如 Agent 页的文档预览：桌面上它是与对话并列的标签页，
 * 手机上应独占整页（见 agent-page/page.tsx）。
 *
 * 之所以要 JS 而不只是 CSS：这里变的是**渲染哪棵子树**，
 * 不是同一棵树上的样式。纯 CSS 只能隐藏元素，无法省掉对话面板的
 * 挂载与副作用。
 *
 * 断点与 `builtin/mobile-layer/mobile.css` 保持一致（900px），
 * 避免出现"抽屉已按手机排布、页面却还按桌面渲染"的错位。
 */
export const NARROW_VIEWPORT_QUERY = "(max-width: 900px)";

export function use_is_narrow_viewport(): boolean {
  const [is_narrow, set_is_narrow] = useState(
    () => window.matchMedia(NARROW_VIEWPORT_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    /** 旋转屏幕或调整窗口都会触发，直接采用查询自身的结果。 */
    const update = (event: MediaQueryListEvent): void => {
      set_is_narrow(event.matches);
    };
    // 挂载与 effect 之间可能已经变化，先对齐一次
    set_is_narrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return is_narrow;
}
