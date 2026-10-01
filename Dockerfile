# ============================================================
# LinguaGacha · 纯 Node 服务器镜像（无 Electron / 无 Chromium）
# ============================================================
#
# 目标场景：纯小说文本翻译（EPUB / TXT / Markdown / SRT / ASS）。
#
# 基础镜像必须锁定**精确小版本**：
#   - `await using`（显式资源管理）在 Node 22 上不可用（实测 22.22.3 连
#     --js-explicit-resource-management 都不支持），Node 24 才支持。
#   - `--permission` 权限模型在 Node 24 仍是 RC 级特性，小版本之间可能变化。
#   24.17.0 是本地实测跑通的版本。
#
# 必须从**源码树**构建，不能从发布包 zip 组装：
#   electron-builder 的 asar: true 会把 builtin/ 与 build/dist-electron/ 打进
#   app.asar，而纯 Node 读不了 asar（那是 Electron 给 fs 打的补丁）。
# ============================================================

ARG NODE_VERSION=24.17.0

# npm 源。默认用国内镜像：实测 registry.npmjs.org 在部分网络下于容器内会
# EIDLETIMEOUT，而 registry.npmmirror.com 容器内可达。需要时用
# --build-arg NPM_REGISTRY=https://registry.npmjs.org 覆盖。
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ============================================================
# 阶段 1：build-deps — 构建期全量依赖
# ============================================================
# 注意：不要在这里设 NODE_ENV=production，否则 npm 可能跳过 devDependencies，
# 而构建本身（vite / rolldown / tailwind / react 类型）需要它们。
# electron-vite 会把 devDependencies 打包进产物，只外部化 dependencies，
# 因此构建期必须装全量。
FROM node:${NODE_VERSION}-slim AS build-deps

ARG NPM_REGISTRY

WORKDIR /src

COPY package.json package-lock.json ./

# --ignore-scripts 跳过 electron postinstall（避免下载约 180MB 的 Electron 二进制）。
# 运行时依赖全部是纯 JS + WASM（mupdf 只有 .js 与 .wasm，无 .node），
# 部署闭包内 0 个原生插件、0 个 install 脚本，因此跳过脚本是安全的。
RUN npm config set registry "$NPM_REGISTRY" \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm ci --ignore-scripts --no-audit --no-fund

# ============================================================
# 阶段 2：prod-deps — 仅运行时依赖
# ============================================================
# 全量 node_modules 是 885MB，只装 dependencies 是 187MB / 206 个包。
FROM node:${NODE_VERSION}-slim AS prod-deps

ARG NPM_REGISTRY

WORKDIR /src

COPY package.json package-lock.json ./

RUN npm config set registry "$NPM_REGISTRY" \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# 裁剪对目标架构无用的平台二进制（必须在本阶段完成）。
#
# 上游把 @earendil-works/pi-* 从 ^0.87 升到 ^0.99 后，pi-coding-agent 的嵌套
# node_modules 会带进 @esbuild 的全部平台包（每个 10~14MB），合计约 285MB。
# esbuild 在运行时由 pi-coding-agent（经 jiti）按需加载，但**只会加载与当前
# 架构匹配的那一个**，其余永远不会被 require。
#
# 关键：裁剪必须放在构建阶段，而不是最终 runner 阶段。legacy builder 下
# `rm` 不会缩小镜像（被删文件仍留在更早的层里）；只有在本阶段删除后
# 再用 COPY --from 复制，最终镜像才只包含裁剪后的树。
#
# 用 node 自己报告目标架构而不是写死 linux-x64，因此 arm64 构建同样正确。
RUN set -eu; \
    case "$(node -p 'process.arch')" in \
      x64)   keep_esbuild=linux-x64 ;; \
      arm64) keep_esbuild=linux-arm64 ;; \
      *)     keep_esbuild="linux-$(node -p 'process.arch')" ;; \
    esac; \
    esbuild_dir=/src/node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild; \
    if [ -d "$esbuild_dir" ]; then \
      for entry in "$esbuild_dir"/*; do \
        [ -d "$entry" ] || continue; \
        [ "$(basename "$entry")" = "$keep_esbuild" ] || rm -rf "$entry"; \
      done; \
      echo "[build] kept @esbuild/$keep_esbuild, pruned other platforms"; \
    fi; \
    pi_tui_native=/src/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/native; \
    if [ -d "$pi_tui_native" ]; then \
      rm -rf "$pi_tui_native/darwin" "$pi_tui_native/win32"; \
      echo "[build] pruned pi-tui native binaries for other platforms"; \
    fi

# ============================================================
# 阶段 3：builder — 产出 bundle 与工作区依赖树
# ============================================================
FROM node:${NODE_VERSION}-slim AS builder

WORKDIR /src

COPY --from=build-deps /src/node_modules ./node_modules
COPY . .

# 只跑应用构建；不跑 electron-builder（那是桌面打包），
# 也不跑 build-pdf-print.mjs（PDF 打印需要 Chromium，本场景不需要）。
RUN npx electron-vite build --config buildtools/vite/electron.vite.config.ts \
 && node buildtools/build-workspace.mjs

# ============================================================
# 阶段 4：runner — 最小运行时
# ============================================================
FROM node:${NODE_VERSION}-slim AS runner

LABEL org.opencontainers.image.title="LinguaGacha Server" \
      org.opencontainers.image.description="LinguaGacha backend + Agent on plain Node (no Electron)" \
      org.opencontainers.image.source="https://github.com/PureMilkchun/LinguaGacha"

# server-entry.ts 的路径约定：
#   resolve_desktop_bundle_dir_from_module_url(import.meta.url)
#     -> /app/dist-electron
#   app_root = bundleDir/.. = /app
# 因此 /app 下必须同时有 version.txt、builtin/、workspace/、dist/、dist-electron/。
WORKDIR /app

# AppMetadataService.read_version() 是严格读取，缺 version.txt 会启动失败。
COPY --chown=node:node --from=builder /src/version.txt /app/version.txt

# 内置资产：系统提示词、人格、会话种子与技能。普通目录，不经 asar。
COPY --chown=node:node --from=builder /src/builtin /app/builtin

# Agent 工作区依赖树（build-workspace.mjs 产出，含 @lg/* 与 mupdf）。
COPY --chown=node:node --from=builder /src/build/resources/workspace /app/workspace

# 渲染器静态产物（由 Gateway 的静态托管路由提供）。
COPY --chown=node:node --from=builder /src/build/dist /app/dist

# 后端 bundle：server-entry.js 与各 worker 入口。
COPY --chown=node:node --from=builder /src/build/dist-electron /app/dist-electron

# 运行时依赖（仅 dependencies，187MB）。
COPY --chown=node:node --from=prod-deps /src/node_modules /app/node_modules

# mupdf 在 package.json 里是 devDependency，但 electron-vite 的 main 配置把它
# 显式 external 了，所以运行时必须能解析到它。mupdf 自身零依赖，
# 因此单独复制它自己的目录即可。
COPY --chown=node:node --from=build-deps /src/node_modules/mupdf /app/node_modules/mupdf

# 健康检查脚本（纯 Node，容器内没有 curl/wget）。
COPY --chown=node:node --from=builder /src/buildtools/docker/healthcheck.mjs /app/healthcheck.mjs

# 数据根：AppPathService 在 appRoot 可写时把数据根放在 appRoot，
# 因此 userdata 与 log 必须可写，并应挂卷持久化。
#
# 注意：这里刻意不使用 `chown -R /app`。所有 COPY 已带 --chown，
# 再对整棵 /app 做递归 chown 会让每一层文件在 overlay 上重新 copy-up，
# 镜像会凭空膨胀约 300MB。
RUN mkdir -p /app/userdata /app/log \
 && chown node:node /app /app/userdata /app/log

# 用官方镜像自带的 node 用户（uid 1000），避免与挂载卷的属主冲突。
USER node

# 固定监听端口：Gateway 默认 port: 0（随机），但容器外的 tunnel ingress
# 规则必须指向一个已知端口，因此服务器部署固定它。
ENV LG_API_PORT=8787

# 服务器入口另外把实际端口写到该文件，便于不带 LG_API_PORT 时也能被健康检查发现。
ENV LG_PORT_FILE=/tmp/lg-port

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node /app/healthcheck.mjs

# 直接 exec node：不经 shell，SIGTERM 由 Node 自己接收并走优雅停机。
# 端口发现通过 LG_PORT_FILE 完成，因此不需要包一层解析 stdout 的入口脚本。
ENTRYPOINT ["node", "/app/dist-electron/server-entry.js"]
