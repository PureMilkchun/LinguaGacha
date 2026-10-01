import React from "react";
import ReactDOM from "react-dom/client";
import { install_web_bridge_shim } from "@frontend/app/desktop/web-bridge-shim";
import App from "@frontend/app";
import { RendererErrorBoundary } from "@frontend/app/diagnostics/renderer-error-boundary";
import { install_renderer_global_error_handlers } from "@frontend/app/diagnostics/renderer-error-reporter";
import "@frontend/index.css";

// 浏览器/服务器模式下安装 window.desktopApp 的纯 Web 替代实现。
// 仅在 window.desktopApp 缺失时生效, Electron 环境完全无副作用。
install_web_bridge_shim();

install_renderer_global_error_handlers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
