/** 浏览器工具栏或软键盘变化时同步可视高度；侧栏状态与遮罩由 React 管理。 */
(function () {
  "use strict";
  function sync_visual_height() {
    var viewport = window.visualViewport;
    if (!viewport || viewport.scale !== 1) return;
    document.documentElement.style.setProperty("--lg-visual-height", viewport.height + "px");
  }
  sync_visual_height();
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", sync_visual_height, { passive: true });
})();
