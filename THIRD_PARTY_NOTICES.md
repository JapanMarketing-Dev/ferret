# Third-party notices

MOVIE-ADE is released under the MIT License ([LICENSE](LICENSE)). This file lists code ported from other projects and the licenses of the main dependencies bundled with the app.

## 1. Ported code

### Orca (MIT)

- Source: <https://github.com/stablyai/orca>
- Commits referenced: `7577366` (1.4.214, 2026-10-01) and later `main`
- License: MIT License, Copyright (c) 2026 Lovecast Inc.

The following files contain code ported or adapted from Orca. Each file names its source in an `Orca由来:` ("derived from Orca") comment near the top. Regenerate this list with `grep -rl "Orca由来" src scripts tools .github` (snapshot as of 2026-10-03).

| MOVIE-ADE file | Orca source file (path in `stablyai/orca`) |
|---|---|
| `.github/scripts/issue-os-label.mjs` | `.github/workflows/issue-os-labeler.yaml` |
| `src/main/accounts/agentConfig.ts` | `src/main/codex-accounts/codex-config-mirror.ts`<br>`src/main/codex/codex-daemon-socket-path-guard.ts` |
| `src/main/accounts/env.ts` | `src/main/claude-accounts/environment.ts`<br>`src/main/codex-accounts/runtime-home-service-launch.ts` |
| `src/main/accounts/identity.ts` | `src/main/claude-accounts/claude-auth-capture.ts`<br>`src/main/claude-accounts/keychain.ts`<br>`src/main/codex-accounts/codex-auth-identity.ts`<br>`src/main/codex-accounts/managed-codex-auth-readiness.ts` |
| `src/main/accounts/paths.ts` | `src/main/claude-accounts/managed-auth-path.ts`<br>`src/main/codex-accounts/codex-managed-home-path.ts`<br>`src/main/codex-accounts/host-codex-managed-home-ownership.ts` |
| `src/main/accounts/service.ts` | `src/main/claude-accounts/claude-account-registration.ts`<br>`src/main/codex-accounts/codex-account-registration.ts`<br>`src/main/codex-accounts/codex-account-selection.ts`<br>`src/main/codex-accounts/service.ts` |
| `src/main/agentDetection.ts` | `src/main/ipc/preflight-command-exec.ts`<br>`src/main/preflight/agent-detection.ts`<br>`src/shared/tui-agent-detection-commands.ts` |
| `src/main/github/index.ts` | `src/main/github/auth-diagnose.ts` |
| `src/main/github/parse.ts` | `src/main/github/auth-diagnose.ts`<br>`src/main/github/github-remote-identity-parsing.ts` |
| `src/main/index.ts` | `src/main/ipc/settings.ts`<br>`src/renderer/src/components/use-terminal-editor-close-foundation.ts` |
| `src/main/inheritedAgentEnv.ts` | `src/main/pty/pi-process-owner-env.ts`<br>`src/main/pty/terminal-color-env.ts` |
| `src/main/locale.ts` | `src/main/i18n/main-i18n.ts` |
| `src/main/platform/windowsSpawn.ts` | `src/shared/child-process/spawn-resolution.ts`<br>`src/shared/child-process/windows-cmd-shim-resolution.ts`<br>`src/shared/child-process/windows-command-line.ts` |
| `src/main/preview/page.css` | `src/renderer/src/assets/markdown-preview.css` |
| `src/main/preview/page.js` | `src/renderer/src/components/editor/MermaidBlock.tsx` |
| `src/main/processCwd.ts` | `src/main/providers/process-cwd.ts` |
| `src/main/projects.ts` | `src/renderer/src/components/sidebar/add-repo-store-upsert.ts` |
| `src/main/recording/sources.ts` | `src/main/browser/browser-media-access.ts`<br>`src/main/ipc/developer-permissions.ts` |
| `src/main/resources.ts` | `src/main/memory/collector.ts` |
| `src/main/resourcesWindows.ts` | `src/main/memory/windows-process-resource-collector.ts`<br>`src/main/memory/windows-process-sample-parsing.ts` |
| `src/main/shellStartup.ts` | `src/main/daemon/daemon-bash-shell-ready-rcfile.ts`<br>`src/main/pty/posix-shell-startup-command.ts`<br>`src/main/shell-templates.ts`<br>`src/main/zsh-startup-wrapper-builder.ts` |
| `src/main/usage/credentials.ts` | `src/main/rate-limits/claude-oauth-credentials.ts`<br>`src/main/rate-limits/codex-backend-auth.ts` |
| `src/main/usage/fetchers.ts` | `src/main/rate-limits/claude-oauth-usage-error.ts`<br>`src/main/rate-limits/claude-oauth-usage-request.ts`<br>`src/main/rate-limits/claude-usage-window.ts`<br>`src/main/rate-limits/codex-backend-usage-client.ts`<br>`src/main/rate-limits/codex-rate-limit-window-classification.ts`<br>`src/main/rate-limits/codex-rate-limit-window-mapper.ts` |
| `src/main/usage/policy.ts` | `src/main/rate-limits/service/service-fetch-policy.ts`<br>`src/main/rate-limits/service/service-polling.ts`<br>`src/main/rate-limits/service/service-result-policy.ts`<br>`src/main/rate-limits/service/service-types.ts` |
| `src/main/usage/service.ts` | `src/main/rate-limits/claude-managed-account-usage.ts`<br>`src/main/rate-limits/service.ts`<br>`src/main/rate-limits/service/service-inactive-accounts.ts`<br>`src/main/rate-limits/service/service-polling.ts` |
| `src/renderer/components/AccountsSection.tsx` | `src/renderer/src/components/settings/AccountsPane.tsx`<br>`src/renderer/src/components/settings/accounts-pane-claude-section.tsx`<br>`src/renderer/src/components/settings/accounts-pane-codex-account-row.tsx`<br>`src/renderer/src/components/settings/accounts-pane-codex-section.tsx`<br>`src/renderer/src/components/settings/accounts-pane-removal-dialogs.tsx` |
| `src/renderer/components/AgentIcon.tsx` | `src/renderer/src/components/status-bar/icons.tsx`<br>`src/renderer/src/lib/agent-catalog.tsx`<br>`src/renderer/src/lib/agent-icon-glyphs.tsx` |
| `src/renderer/components/agentIconData.ts` | `src/renderer/src/lib/agent-favicon-assets.ts`<br>`src/shared/agent-icons/` |
| `src/renderer/components/CenterTabs.tsx` | `src/renderer/src/components/tab-bar/` |
| `src/renderer/components/FileExplorer.tsx` | `src/renderer/src/components/right-sidebar/` |
| `src/renderer/components/QuickLaunchButton.tsx` | `src/renderer/src/components/tab-bar/QuickLaunchButton.tsx` |
| `src/renderer/components/QuickOpen.tsx` | `src/renderer/src/components/quick-open-file-list.ts` |
| `src/renderer/components/ResourceManager.tsx` | `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx` |
| `src/renderer/components/Sidebar.tsx` | `src/renderer/src/components/sidebar/` |
| `src/renderer/components/Splitter.tsx` | `src/renderer/src/components/tab-group/TabGroupSplitLayout.tsx` |
| `src/renderer/components/TerminalPane.tsx` | `src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts`<br>`src/renderer/src/lib/pane-manager/pane-divider-drag.ts`<br>`src/renderer/src/lib/pane-manager/pane-divider.ts`<br>`src/shared/keybindings/definitions-core-4.ts` |
| `src/renderer/components/UnsavedChangesDialog.tsx` | `src/renderer/src/components/use-terminal-editor-close-dialog-actions.ts` |
| `src/renderer/components/UrlPresets.tsx` | `src/renderer/src/components/browser-pane/` |
| `src/renderer/components/UsageMeter.tsx` | `src/renderer/src/components/status-bar/ClaudeSwitcherMenu.tsx`<br>`src/renderer/src/components/status-bar/StatusBar.tsx`<br>`src/renderer/src/components/status-bar/StatusBarProviderSegment.tsx`<br>`src/renderer/src/components/status-bar/UsageRosterPanel.tsx`<br>`src/renderer/src/components/status-bar/status-bar-claude-accounts.ts`<br>`src/renderer/src/components/status-bar/status-bar-codex-accounts.ts` |
| `src/renderer/editor/FileEditor.tsx` | `src/renderer/src/components/editor/EditorPanel.tsx` |
| `src/renderer/editor/language.ts` | `src/renderer/src/lib/language-detect.ts` |
| `src/renderer/editor/monacoSetup.ts` | `src/renderer/src/lib/monaco-setup.ts` |
| `src/renderer/editor/richMarkdown/RichMarkdownEditor.tsx` | `src/renderer/src/components/editor/RichMarkdownEditor.tsx`<br>`src/renderer/src/components/editor/useRichMarkdownEditorInstance.ts` |
| `src/renderer/editor/richMarkdown/codec.ts` | `src/renderer/src/components/editor/rich-markdown-extensions.ts` |
| `src/renderer/editor/richMarkdown/reconcile.ts` | `src/renderer/src/components/editor/rich-markdown-source-reconcile.ts`<br>`src/renderer/src/components/editor/rich-markdown-block-source.ts`<br>`src/renderer/src/components/editor/markdown-frontmatter.ts` |
| `src/renderer/editor/useOpenFiles.ts` | `src/renderer/src/components/editor/editor-content-dirty-state.ts` |
| `src/renderer/hooks/useAgentAccounts.ts` | `src/renderer/src/components/settings/accounts-pane-account-actions.ts`<br>`src/renderer/src/components/status-bar/ClaudeSwitcherMenu.tsx` |
| `src/renderer/lib/theme.ts` | `src/renderer/src/lib/document-theme.ts` |
| `src/renderer/lib/usageDensity.ts` | `src/renderer/src/components/status-bar/status-bar-density.ts` |
| `src/renderer/styles/shell.css` | (sizes and other design values) |
| `src/renderer/styles/tokens.css` | `src/renderer/src/assets/main.css`<br>`src/shared/terminal-themes/defaults.ts` |
| `src/renderer/styles/ui.css` | (sizes and other design values) |
| `src/renderer/terminal/paneTree.ts` | `src/renderer/src/lib/pane-manager/pane-divider-drag.ts`<br>`src/renderer/src/lib/pane-manager/pane-tree-ops.ts`<br>`src/shared/constants.ts`<br>`src/shared/default-global-settings.ts`<br>`src/shared/terminal-tab-types.ts` |
| `src/renderer/terminal/quickLaunchSearch.ts` | `src/renderer/src/components/tab-bar/TabBarCreateEntry.tsx`<br>`src/renderer/src/components/tab-bar/tab-create-entry-classifier.ts`<br>`src/renderer/src/components/tab-bar/tab-create-entry-url-classification.ts` |
| `src/shared/accounts.ts` | `src/shared/managed-account-types.ts` |
| `src/shared/agentCatalog.ts` | `src/renderer/src/lib/agent-catalog.tsx`<br>`src/shared/agent-node-entrypoint-identities.ts`<br>`src/shared/agent-node-package-entrypoints.ts`<br>`src/shared/agent-process-recognition.ts`<br>`src/shared/tui-agent-config.ts`<br>`src/shared/tui-agent-permissions.ts` |
| `src/shared/agentLaunch.ts` | `src/shared/commit-message-prompt.ts`<br>`src/shared/powershell-native-argument.ts`<br>`src/shared/tui-agent-launch-command.ts`<br>`src/shared/tui-agent-startup-shell.ts` |
| `src/shared/appVersion.ts` | `src/shared/app-version.ts` |
| `src/shared/files.ts` | `src/main/ipc/filesystem/filesystem-file-content-inspection.ts`<br>`src/shared/binary-buffer.ts`<br>`src/shared/binary-file-extensions.ts`<br>`src/shared/quick-open-filter.ts` |
| `src/shared/i18n/en.ts` | `src/renderer/src/i18n/locales/en.json` |
| `src/shared/i18n/index.ts` | `src/renderer/src/i18n/i18n.ts`<br>`src/renderer/src/i18n/relative-time-format.ts`<br>`src/shared/ui-locale.ts` |
| `src/shared/projectUrl.ts` | `src/shared/browser-url.ts` |
| `src/shared/quickOpen.ts` | `src/shared/quick-open-path-search.ts` |
| `src/shared/resources.ts` | `src/renderer/src/components/status-bar/resource-usage-metrics.tsx`<br>`src/shared/process-stats-types.ts` |
| `src/shared/theme.ts` | `src/renderer/src/lib/document-theme.ts` |
| `src/shared/usage.ts` | `src/renderer/src/components/status-bar/UsageRosterPanel.tsx`<br>`src/renderer/src/components/status-bar/tooltip.tsx`<br>`src/renderer/src/lib/window-label-formatter.ts`<br>`src/shared/rate-limit-reset-format.ts`<br>`src/shared/rate-limit-types.ts` |

Full text of the Orca license:

```text
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Design references only (no code ported)

The following projects, surveyed in [docs/04_benchmark.md](docs/04_benchmark.md), informed the design only. No source code was copied from them.

| Project | License | What we referred to |
|---|---|---|
| herdr (`github.com/herdrdev/herdr`) | Apache-2.0 | How agent states are modeled (such as the "seen" flag) |
| FeedbackRecorder (`github.com/magnuslandahl/FeedbackRecorder`) | MIT | The flow from a recording to feedback |
| Clipy / AREC spec | Spec text under CC BY 4.0 | Ideas for the recording format (no spec text is quoted) |

### Solocut (MIT)

The video features (`src/video/`: the `ferret-video` CLI and its packages, the built-in templates, recording, the video review screen and YouTube / TikTok posting) are ported from Solocut (`github.com/JapanMarketing-Dev/solocut`, version 0.2.1), which is no longer published separately. Solocut is by the same organization and itself adapts code from Ferret and Orca (listed above).

```
MIT License

Copyright (c) 2026 JapanMarketing-Dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Main dependencies bundled with the app

The built app includes the following packages (versions as pinned in `pnpm-lock.yaml`). Full license texts are in `node_modules/<package>/LICENSE`.

| Package | License | Copyright holder |
|---|---|---|
| electron (includes Chromium and Node.js) | MIT (licenses of Chromium and other components ship as `LICENSES.chromium.html` in the app) | Electron contributors / GitHub Inc. |
| node-pty | MIT | Microsoft Corporation and contributors |
| @xterm/xterm, @xterm/addon-fit / -webgl / -canvas | MIT | The xterm.js authors |
| monaco-editor | MIT | Microsoft Corporation |
| @monaco-editor/react | MIT | Suren Atoyan |
| mermaid | MIT | Knut Sveidqvist and contributors |
| marked | MIT | Christopher Jeffrey / MarkedJS |
| @tiptap/core, @tiptap/pm, @tiptap/starter-kit, @tiptap/markdown, @tiptap/extension-* (and the prosemirror-* packages they use) | MIT | Tiptap GmbH; ProseMirror: Marijn Haverbeke and others |
| react, react-dom | MIT | Meta Platforms, Inc. and affiliates |
| lucide-react | ISC | Lucide Contributors |
| ajv | MIT | Evgeny Poberezkin |
| @sentry/electron (and the @sentry/* packages it uses) | MIT | Functional Software, Inc. dba Sentry |
| @sentry/electron (with @sentry/node, @sentry/browser, @sentry/core) | MIT | Functional Software, Inc. dba Sentry |
| @fontsource-variable/inter (Inter) | SIL Open Font License 1.1 | The Inter Project Authors |
| @fontsource-variable/jetbrains-mono (JetBrains Mono) | SIL Open Font License 1.1 | The JetBrains Mono Project Authors |
| zod (video CLI) | MIT | Colin McDonnell |
| yaml (video CLI, templates) | ISC | Eemeli Aro |
| budoux (video CLI, Japanese caption line breaks) | Apache-2.0 | Google LLC |

The following packages are pulled in by mermaid and bundled unmodified:

| Package | License | Note |
|---|---|---|
| dompurify | MPL-2.0 or Apache-2.0 | Used under Apache-2.0 |
| elkjs | EPL-2.0 | Unmodified. Source: <https://github.com/kieler/elkjs> |
| d3, khroma, cytoscape and others | MIT / ISC / BSD and similar | |

The following packages are pulled in by @sentry/electron and bundled unmodified:

| Package | License |
|---|---|
| @opentelemetry/api, web-vitals | Apache-2.0 |
| glob, minimatch, minipass, path-scurry, lru-cache | BlueOak-1.0.0 |
| others | MIT / ISC / BSD |

The Sentry CLI package (`sentry`, FSL-1.1-Apache-2.0) and other build-time tools that `@sentry/node` depends on are excluded from the app (see `files` in `electron-builder.config.cjs`).

## 3. Not bundled; provided by the user

| Item | License |
|---|---|
| whisper.cpp (for on-device transcription) | MIT |
| Whisper GGML models (downloaded by the user from `huggingface.co/ggerganov/whisper.cpp`) | MIT (OpenAI Whisper) |
| Codex CLI, Claude Code and other agents | Each provider's terms |
| FFmpeg / ffprobe (downloaded on first use by `ferret-video lib install`, from BtbN/FFmpeg-Builds or martin-riedl.de, checked against the publisher's sha256) | LGPL-2.1+ / GPL depending on the build; see the downloaded archive |
| Noto Sans JP, JetBrains Mono (caption fonts, downloaded on first use) | SIL Open Font License 1.1 |
