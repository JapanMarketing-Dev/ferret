import { MAX_BROWSER_EXTENSIONS } from './browserExtensions'
import { DEFAULT_LIMIT_FAILOVER, MAX_FAILOVER_THRESHOLD, MIN_FAILOVER_THRESHOLD } from './failover'
import { ANNOTATION_COLOR_IDS, DEFAULT_ANNOTATION_COLOR } from './annotation'
import { AGENT_CATALOG, BUILTIN_AGENTS, DEFAULT_AGENT_PREFERENCES } from './agentCatalog'
import { DECISION_PRESET_IDS } from './decision'
import { LLM_API_PROVIDERS, STT_REMOTE_PROVIDERS } from './aiProviders'
import { LOCALE_PREFERENCES } from './i18n'
import { DEFAULT_LAYOUT, FIXED_DOCKS, FOOTER_ITEMS, PANEL_IDS, TERMINAL_DOCKS } from './layout'
import { ONBOARDING_STEPS } from './onboarding'
import { STT_LANGUAGE_CODES } from './sttLanguages'
import { DEFAULT_PROJECT_KIND, DEFAULT_TARGET_PURPOSE, PROJECT_KINDS, TARGET_PURPOSES } from './projectTargets'
import { PROJECT_SOURCES } from './projectSource'
import { DEFAULT_SPLIT_RATIO, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './types'
import { MOBILE_REMOTE_DEFAULT_PORT, MOBILE_REMOTE_MAX_PORT, MOBILE_REMOTE_MIN_PORT } from './mobileRemote'

/**
 * settings.json の JSON Schema（draft 2020-12）。
 * 利用者の Claude Code / Codex が settings.json を書き換えるときの手がかり（説明・型・既定値）で、
 * アプリ自身も外部の変更を取り込む前にこれで確かめる（validateSettingsJson）。
 *
 * 型（src/shared/types.ts）と sanitize（src/main/settings.ts）に合わせて手で保つ。
 * 列挙（エージェント・提供元・パネル）は各モジュールの定数から作るので、そちらを足せば自動で増える。
 * ずれは test/unit/settings-schema.test.ts が落とす。説明は英語（エージェント・エディタに読ませるため）。
 */

export type JsonSchema = {
  $schema?: string
  $id?: string
  title?: string
  description?: string
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | Array<'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'>
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  required?: string[]
  items?: JsonSchema
  enum?: readonly unknown[]
  pattern?: string
  minimum?: number
  maximum?: number
  maxLength?: number
  default?: unknown
  examples?: unknown[]
  deprecated?: boolean
  markdownDescription?: string
}

/** 状態（state.json）として別に持つ項目。settings.json に書かない（src/main/settingsFile.ts） */
export const STATE_KEYS = ['folderPath', 'url', 'viewport', 'activeProjectId', 'starPrompt'] as const

/** 読み込むときに移し替えるだけの古い項目。settings.json に書き戻さない */
export const LEGACY_KEYS = ['terminalDock', 'terminalClipboard'] as const

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra })
const bool = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'boolean', description, ...extra })

const ENV_NAME = '^[A-Za-z_][A-Za-z0-9_]{0,127}$'

/** 認証の形・追加のヘッダー（値は文字列か { env }）・Cloudflare のアカウント。どの接続先（文字起こし・整理・判定）も同じ名前と形 */
const AUTH_FIELDS: Record<string, JsonSchema> = {
  authScheme: { type: 'string', description: 'How the key is sent. Omit for the provider default (Bearer for OpenAI-compatible APIs, x-api-key for Anthropic...). "bearer" = Authorization: Bearer <key>, "header" = the key as the value of authHeader, "none" = send no key.', enum: ['bearer', 'header', 'none'] },
  authHeader: str('Header name that carries the key when authScheme is "header", e.g. "x-api-key" or "api-key".', { pattern: '^[A-Za-z0-9-]{1,64}$' }),
  headers: {
    type: 'object',
    description: 'Extra HTTP headers. A value is a plain string, or {"env": "VAR_NAME"} to read it from an environment variable (looked up like apiKeyEnv). Secret headers such as Authorization or cf-aig-authorization are only accepted as {"env": ...}.',
    additionalProperties: {
      type: ['string', 'object'],
      description: 'Plain value (printable ASCII, no newlines) or {"env": "VAR_NAME"}.',
      maxLength: 2000,
      required: ['env'],
      additionalProperties: false,
      properties: { env: str('Environment variable that holds the header value.', { pattern: ENV_NAME }) }
    }
  },
  accountId: str('Replaces {account_id} in the URL (Cloudflare Workers AI). Omit to read the CLOUDFLARE_ACCOUNT_ID environment variable.', { pattern: '^[A-Za-z0-9_-]{1,100}$' })
}

/** 提供元ごとの接続先（AiEndpointConfig）。キーの持ち方3通りもここ */
const endpointSchema = (what: string): JsonSchema => ({
  type: 'object',
  description: `Overrides for this ${what} provider. Omitted fields use the built-in preset.`,
  additionalProperties: false,
  properties: {
    baseUrl: str('Base URL of the API (http or https). Any OpenAI-compatible or self-hosted server works, e.g. "http://localhost:8000/v1" or "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1". {account_id} is filled from accountId / CLOUDFLARE_ACCOUNT_ID. Never embed credentials in the URL.', { pattern: '^https?://', maxLength: 500 }),
    model: str('Model name sent to the API (for Azure OpenAI, the deployment name).', { maxLength: 200 }),
    timeoutMs: { type: 'integer', description: 'Request timeout in milliseconds (1000-600000).', minimum: 1000, maximum: 600000 },
    apiVersion: str('Azure OpenAI api-version, e.g. "2024-06-01".', { pattern: '^[0-9A-Za-z.-]{1,40}$' }),
    apiKeyEnv: str('Name of an environment variable that holds the API key, e.g. "OPENAI_API_KEY". Looked up in the app\'s environment, then in the open project\'s .env file. Preferred over apiKey.', { pattern: ENV_NAME }),
    apiKey: str('WARNING: plaintext API key stored in this file. Anyone who can read settings.json can read it. Prefer apiKeyEnv or the key field in the Settings page (encrypted with the OS keychain). Takes precedence over apiKeyEnv and the saved key.', { maxLength: 500 }),
    ...AUTH_FIELDS
  }
})

const endpointMap = (providers: readonly string[], what: string, description: string): JsonSchema => ({
  type: 'object',
  description,
  additionalProperties: false,
  properties: Object.fromEntries(providers.map((p) => [p, endpointSchema(what)]))
})

const agentId: JsonSchema = { type: 'string', description: `A built-in agent id (${BUILTIN_AGENTS.join(', ')}) or a custom agent id ("custom:<slug>"). Unknown ids are ignored.` }

const accountList: JsonSchema = {
  type: 'object',
  description: 'Accounts registered for this agent. Managed by the Accounts section; edit with care.',
  properties: {
    accounts: {
      type: 'array',
      description: 'Registered accounts.',
      items: {
        type: 'object',
        description: 'One account (its config folder lives in the app data folder).',
        required: ['id'],
        properties: {
          id: str('Account id (folder name).'),
          label: str('Display name.', { maxLength: 80 }),
          email: { type: ['string', 'null'], description: 'Signed-in email, if known.' },
          workspaceLabel: { type: ['string', 'null'], description: 'Organization or workspace name, if known.' },
          createdAt: { type: 'number', description: 'Creation time (ms since epoch).' },
          updatedAt: { type: 'number', description: 'Last update time (ms since epoch).' },
          lastAuthenticatedAt: { type: ['number', 'null'], description: 'Last sign-in time (ms since epoch).' }
        }
      }
    },
    activeAccountId: { type: ['string', 'null'], description: 'Account used for new agent tabs. null means the system default account.' }
  }
}

export const SETTINGS_SCHEMA: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ferretade.dev/schemas/settings.schema.json',
  title: 'Ferret settings',
  description: 'User configuration for Ferret. The app reloads this file live when it changes. Unknown keys are kept. API keys belong in apiKeyEnv (recommended) or the Settings page, not in this file.',
  type: 'object',
  additionalProperties: true,
  properties: {
    $schema: str('Path or URL of this JSON Schema. Lets editors and agents validate the file.'),
    theme: { type: 'string', description: 'Color theme. "system" follows the OS.', enum: ['system', 'light', 'dark'], default: 'system' },
    locale: { type: 'string', description: 'UI language. "system" follows the OS. Unknown values fall back to "en". Separate from the transcription language.', enum: LOCALE_PREFERENCES, default: 'system' },
    splitRatio: { type: 'number', description: 'Share of the main area taken by the center tabs when the terminal is docked beside or below them.', minimum: MIN_SPLIT_RATIO, maximum: MAX_SPLIT_RATIO, default: DEFAULT_SPLIT_RATIO },
    layout: {
      type: 'object',
      description: 'Which panels are shown, where the terminal is docked, and the footer items.',
      default: DEFAULT_LAYOUT,
      properties: {
        panels: {
          type: 'object',
          description: 'Placement of each side panel.',
          additionalProperties: false,
          properties: Object.fromEntries(PANEL_IDS.map((id) => [id, {
            type: 'object',
            description: `Placement of the ${id} panel.`,
            additionalProperties: false,
            properties: {
              dock: id === 'terminal'
                ? { type: 'string', description: 'Edge the terminal is docked to (right or bottom).', enum: TERMINAL_DOCKS }
                : { type: 'string', description: 'Edge the panel is docked to. Fixed; other values fall back to it.', enum: [FIXED_DOCKS[id]] },
              visible: bool('Show the panel.')
            }
          } satisfies JsonSchema]))
        },
        footer: {
          type: 'object',
          description: 'Footer (status bar).',
          additionalProperties: false,
          properties: {
            dock: { type: 'string', description: 'Top or bottom of the window.', enum: ['top', 'bottom'] },
            visible: bool('Show the footer.'),
            items: {
              type: 'object',
              description: 'Which footer items are shown.',
              additionalProperties: false,
              properties: Object.fromEntries(FOOTER_ITEMS.map((id) => [id, bool(`Show the ${id} item.`)]))
            }
          }
        }
      }
    },
    feedbackTargets: {
      type: 'object',
      description: 'The review-targets panel on the right of feedback mode.',
      additionalProperties: false,
      properties: {
        visible: bool('Show the panel.', { default: true }),
        ratio: { type: 'number', description: 'Share of the width given to the page (the rest is the panel).', minimum: 0.3, maximum: 0.95, default: 0.78 }
      }
    },
    projects: {
      type: 'array',
      description: 'Registered projects. Terminals and agents start in the project folder.',
      items: {
        type: 'object',
        description: 'One project.',
        required: ['id', 'folderPath'],
        properties: {
          id: str('Stable id. Any unique string; keep it when editing.'),
          name: str('Display name. Defaults to the folder name.'),
          folderPath: str('Absolute path of the project folder.'),
          starred: { type: 'boolean', description: 'Starred (favorite). Starred projects stay at the top of the sidebar and can be shown alone.' },
          members: { type: 'array', items: { type: 'string', description: 'Id of a project put under this orchestrator.' }, description: 'Orchestrator only: ids of existing projects put under this orchestrator (their folders stay where they are). They appear under it in the sidebar and get a subagent like the subfolder projects.' },
          orchestraExcluded: { type: 'boolean', description: 'Leave this project out of the orchestra: no subagent in All products, not in rounds, not touched by requests sent from All products. For projects that should not change right now.' },
          browserProfile: str('Built-in browser sign-in group. Leave it out to share sign-ins (cookies, saved site data) with every project; projects with the same name share one group and are kept apart from the rest (for example one per client). Up to 40 characters.'),
          research: { type: 'boolean', description: 'Business research folder (research.yaml). Listed under "Business research" above the orchestras and never part of an orchestra; promising candidates become orchestra projects with "Make it a project". Set by the app.' },
          editorWorkspace: { type: 'boolean', description: 'The built-in "All projects" entry (set by the app). Its hidden folder links every registered project as a subfolder; the agent started there hands work to each project\'s subagent.' },
          orchestrator: { type: 'boolean', description: 'Orchestrator. Projects in the subfolders (git repositories or registered projects) become Claude Code subagents in <folder>/.claude/agents/ferret-*.md, and reviews sent from here tell the agent to hand each finding to the right subagent. Ferret rewrites those files when the project is opened.' },
          addedAt: str('When the project was added (ISO 8601). Used by the "Date added" sort; set by the app.'),
          lastOpenedAt: str('When the project was last opened (ISO 8601). Used by the "Recently used" and "Active first" sorts; set by the app.'),
          kind: { type: 'string', description: 'Kind of app. Decides which target fields the UI shows; all fields are kept either way.', enum: PROJECT_KINDS, default: DEFAULT_PROJECT_KIND },
          source: { type: 'string', description: 'Where the project lives: "local" (a folder on this machine), "github" (cloned from remoteUrl) or "ssh" (a folder on a remote host, see ssh). Separate from kind.', enum: PROJECT_SOURCES, default: 'local' },
          remoteUrl: str('For source "github": the URL it was cloned from. Never include a token or user:password in the URL; credentials are dropped.', { pattern: '^(https?://|git@|ssh://)' }),
          ssh: {
            type: 'object',
            description: 'For source "ssh" (required there): the remote host and folder. folderPath then points to the local folder where reviews for it are kept.',
            required: ['host', 'path'],
            properties: {
              host: str('A Host from ~/.ssh/config, or user@host.'),
              path: str('Absolute remote path, or a path starting with ~.', { pattern: '^(/|~)' })
            }
          },
          urls: {
            type: 'array',
            description: 'Review targets (named freely, no limit): a URL for the built-in browser, a command to launch the app, and/or a window to record. The first one opens by default.',
            items: {
              type: 'object',
              description: 'One review target. Needs at least one of url, launchCommand or windowMatch.',
              properties: {
                id: str('Stable id. Any unique string within the project; generated when omitted.'),
                label: str('Name shown in the target menu, e.g. "local", "prd" or "iOS sim".', { maxLength: 100 }),
                url: str('URL opened in the built-in browser.'),
                launchCommand: str('Command run in a terminal in the project folder when the target is chosen, e.g. "pnpm tauri dev".'),
                windowMatch: str('The app or window to record: part of the app or window name (e.g. "Simulator"), a macOS bundle id (e.g. "com.example.MyApp") or the path of the app or executable (e.g. "/Applications/MyApp.app", "C:\\Program Files\\MyApp\\MyApp.exe"; only its name is compared). On Windows and Linux only window titles are known, so the name is matched against the title.', { maxLength: 200 }),
                watch: { type: 'string', description: 'While a recording is running, wait for this window (windowMatch) and record it as soon as it appears, for example a desktop app that a web app launches. "record" records it alongside the current view; "switch" also switches the view to it. It is recorded again if it closes and reopens. Up to 4 videos are recorded at once. Not available on Linux under Wayland. Omitted means do not wait.', enum: ['record', 'switch'] },
                purpose: { type: 'string', description: 'What the target is: "app" (the app under development), "design" (Figma, Penpot, Canva, a prototype...), "doc" (a spec or design doc: Google Docs, Notion, Confluence, a Markdown file on GitHub, a PDF...) or "reference" (an external site you cannot change, such as a competitor or an example, viewed for reference). Findings recorded on it are marked with it in feedback.md, so the agent updates the design or document instead of the code, and for "reference" never touches that site but adopts or avoids the pattern in the project\'s own app. An "app" target whose label contains "競合", "参考", "competitor" or "reference" is treated as "reference". Omitted means "app".', enum: TARGET_PURPOSES, default: DEFAULT_TARGET_PURPOSE }
              }
            }
          }
        }
      }
    },
    agents: {
      type: 'object',
      description: 'Coding agents (Claude Code, Codex...) launched in terminal tabs.',
      default: DEFAULT_AGENT_PREFERENCES,
      properties: {
        launch: {
          type: 'object',
          description: 'Command and arguments for each built-in agent. Only the agents you list are overridden. Ids this version does not know are kept.',
          additionalProperties: { type: 'object', description: 'How to launch an agent added in a newer version.' },
          properties: Object.fromEntries(BUILTIN_AGENTS.map((id) => [id, {
            type: 'object',
            description: `How to launch ${id}.`,
            properties: {
              command: str('Executable name or path.'),
              args: str('Arguments, as typed in a shell.')
            }
          } satisfies JsonSchema]))
        },
        customAgents: {
          type: 'array',
          description: 'Your own agents (any CLI or wrapper script).',
          items: {
            type: 'object',
            description: 'One custom agent.',
            properties: {
              id: str('Id in the form "custom:<slug>". Generated from the name when omitted.', { pattern: '^custom:[a-z0-9][a-z0-9-]{0,47}$' }),
              name: str('Display name.'),
              command: str('Executable name or path.'),
              args: str('Arguments, as typed in a shell.'),
              processName: str('Foreground process name used to detect the agent for "Send to agent". Defaults to the first word of command.'),
              icon: str('One or two characters shown as the icon. Defaults to the first letter of name.', { maxLength: 8 })
            }
          }
        },
        disabledAgents: { type: 'array', description: 'Agents hidden from menus.', items: agentId },
        startupAgents: { type: 'array', description: 'Agent tabs opened automatically when a project opens, in order. Empty means one plain shell. They start with the same arguments as agents you open yourself.', items: agentId },
        skipPermissions: bool(`Start Claude Code with ${AGENT_CATALOG.claude.yoloArgs} and Codex with ${AGENT_CATALOG.codex.yoloArgs}, added before your launch args, and mark registered project folders as trusted for both. Not added when your args already choose a permission mode. Turn off to start them in their normal mode.`, { default: true }),
        notify: bool('Show a system notification when all agents in a project have finished, or when an agent is waiting for a permission or an answer. Nothing is shown for the tab you are looking at. Clicking the notification opens that tab.', { default: false }),
        restoreTerminals: bool('Remember terminal tabs (order, split, folder, agent and account) and the text on their screens, and bring them back when Ferret starts again and when you reopen a closed terminal (Cmd/Ctrl+Shift+T). Claude Code reopens with --continue and Codex with resume --last. Up to 2,000 lines per terminal are kept in Ferret\'s own data folder, never in the project. Turning this off deletes what was saved.', { default: true }),
        agentMail: bool('Agent mail: an agent in a Ferret terminal can ask another agent (Codex, Claude Code, Antigravity, ...) to do a task in a visible Ferret terminal and get the result back as a file, back and forth. Ferret gives each terminal FERRET_AGENT_CLI, FERRET_AGENT_MAIL and FERRET_AGENT_ID, pastes requests and replies into the terminals, opens the other agent next to the sender when it is not running, and installs the ferret-agent-mail skill for Claude Code and Codex. Turn off to stop delivering and remove the skill.', { default: true }),
        windowsShell: { type: 'string', description: 'Windows only: the shell for terminal tabs. powershell (default) uses PowerShell 7 (pwsh) when installed, otherwise Windows PowerShell, and keeps command history between tabs and restarts (Up arrow). cmd uses cmd.exe, which forgets history when a tab closes. Applies to tabs opened afterwards.', enum: ['powershell', 'cmd'], default: 'powershell' }
      }
    },
    agentAccounts: {
      type: 'object',
      description: 'Account switching for Claude Code and Codex.',
      properties: { claude: accountList, codex: accountList }
    },
    limitFailover: {
      type: 'object',
      description: 'Keep working when an agent reaches its usage limit: switch to another signed-in account of the same agent, then hand the work to the next agent in agentOrder, in the same project folder.',
      properties: {
        enabled: bool('Switch automatically when a usage limit is reached.', { default: DEFAULT_LIMIT_FAILOVER.enabled }),
        thresholdPercent: { type: 'integer', description: 'An account counts as at its limit when its highest usage (5-hour, weekly or per-model) reaches this percentage.', minimum: MIN_FAILOVER_THRESHOLD, maximum: MAX_FAILOVER_THRESHOLD, default: DEFAULT_LIMIT_FAILOVER.thresholdPercent },
        switchAccounts: bool('Try another signed-in account of the same agent (Claude Code, Codex) before moving to the next agent. Between accounts that Ferret manages, the same conversation is resumed.', { default: DEFAULT_LIMIT_FAILOVER.switchAccounts }),
        agentOrder: { type: 'array', description: 'Agents to hand the work to, highest priority first. Agents not listed are never used.', items: agentId, default: DEFAULT_LIMIT_FAILOVER.agentOrder },
        returnToPreferred: bool('When a higher agent in agentOrder is available again, move idle switched tabs back to it. Off keeps working with the current agent.', { default: DEFAULT_LIMIT_FAILOVER.returnToPreferred }),
        handoffPercent: { type: 'integer', description: 'Before the limit: when the account a running tab uses reaches this percentage, Ferret has that agent write its progress to .ferret/handoff.md, closes it and continues in a new tab with the next account or agent in agentOrder, so work keeps going with nobody at the computer. 100 waits for the limit message instead.', minimum: MIN_FAILOVER_THRESHOLD, maximum: MAX_FAILOVER_THRESHOLD, default: DEFAULT_LIMIT_FAILOVER.handoffPercent }
      }
    },
    orchestra: {
      type: 'object',
      description: 'Rules people write for All products (Settings > Orchestra). Ferret puts them in the All products CLAUDE.md / AGENTS.md and in each product\'s subagent.',
      properties: {
        shared: str('Rules shared by all products (conventions, security, design, docs).', { maxLength: 8000 }),
        allowed: str('Operations agents may do without asking a person, one per line (for example "deploy to the dev environment", "add dependencies"). They go into the All products CLAUDE.md / AGENTS.md and each subagent, are sent with the answers from the dashboard, and are kept out of human.md.', { maxLength: 8000 }),
        products: { type: 'object', description: 'Project id → rules only for that product (infrastructure, tags, instances, deployment).', additionalProperties: str('Rules for one product.', { maxLength: 8000 }) }
      }
    },
    agentRequests: {
      type: 'object',
      description: 'Ready-made requests to the agent (on the All products dashboard): writing what people must check into human.md, recording costs, memory tidy-up (dream), compacting instructions, security check, SEO, analytics, Sentry fixes, performance, accessibility, dependency updates, plus your own. Pressing Send only sends the text to the agent of the open project.',
      properties: {
        items: {
          type: 'array',
          description: 'Changes to the built-in requests and requests you added.',
          items: {
            type: 'object',
            description: 'One request.',
            required: ['id'],
            properties: {
              id: str('Built-in id (human-checklist, costs, dream, learn-human, dev-servers, chrome-extension, compact, security, seo, analytics, sentry, sentry-setup, analytics-setup, search-console, infra, performance, accessibility, dependencies and others) or any id for your own request.'),
              title: str('Name of your own request.'),
              text: str('Request text. For a built-in request, omit it to use the default.', { maxLength: 6000 }),
              batch: bool('Include it in "Send selected together".'),
              custom: bool('A request you added.'),
              hidden: bool('Hide it from the list on the All products dashboard (for one-time requests that are done).')
            }
          }
        }
      }
    },
    agentPrompt: str('One-line instruction sent to the agent with a review. {{path}} is the absolute path of feedback.md, {{relpath}} the project-relative path. Omit for the default.', { maxLength: 2000 }),
    whisperModel: str('Absolute path of the local whisper.cpp model (ggml .bin) used for local transcription.'),
    capture: {
      type: 'object',
      description: 'Recording and transcription.',
      properties: {
        captureMic: bool('Record the microphone.', { default: true }),
        captureSystemAudio: bool('Also record system audio (the other side of a call) as a separate speaker.', { default: false }),
        micDeviceId: str('Microphone device id. Empty or omitted means the system default.'),
        transcription: { type: 'string', description: 'Transcription provider. "local" runs whisper.cpp on this machine for free; the others use your own API key and endpoint.', enum: ['local', ...STT_REMOTE_PROVIDERS], default: 'local' },
        language: { type: 'string', description: 'Spoken language: "auto" or an ISO 639-1 code supported by Whisper (e.g. "en", "ja", "de"; "haw" and "yue" are the only 3-letter codes). Separate from the UI language.', enum: ['auto', ...STT_LANGUAGE_CODES], default: 'auto' },
        keepDays: { type: 'integer', description: 'Days to keep recordings. 0 keeps them forever.', minimum: 0, maximum: 3650, default: 7 },
        stayFeedbackOnStop: bool('Stay in feedback mode after stopping a recording.', { default: false }),
        trimIdle: bool('After a recording stops, make a copy with idle parts removed (no voice, drawing, clicks, scrolling, navigation or screen change) and play that one. The original recording is kept.', { default: true }),
        showLiveTranscript: bool('While recording, show the live transcript in a Transcript tab of the right panel in feedback mode. Warnings when nothing is being transcribed are shown even when this is off.', { default: true }),
        trimIdleSeconds: { type: 'integer', description: 'Idle time (seconds) that gets trimmed. 0.5 s is kept on each side of a cut.', minimum: 1, maximum: 60, default: 3 },
        annotationColor: { type: 'string', description: 'Color of pen strokes and boxes drawn while recording. Usually set from the recording toolbar.', enum: ANNOTATION_COLOR_IDS, default: DEFAULT_ANNOTATION_COLOR },
        captureTarget: {
          type: 'object',
          description: 'Last capture target. Usually set from the UI.',
          required: ['kind'],
          properties: {
            kind: { type: 'string', description: 'browser = built-in browser, screen = a whole display, window = another app window.', enum: ['browser', 'screen', 'window'] },
            sourceId: str('desktopCapturer source id (screen:... or window:...).'),
            name: str('Screen or window name, used to find it again after a restart.'),
            displayId: str('Display id for screens.'),
            also: {
              type: 'array',
              description: 'Other screens or windows recorded side by side in the same video (checked in the capture picker). Up to 3, each with kind, sourceId and name.',
              items: { type: 'object', description: 'One more screen or window.', required: ['kind', 'sourceId'], properties: { kind: { type: 'string', description: 'screen or window.', enum: ['screen', 'window'] }, sourceId: str('desktopCapturer source id.'), name: str('Screen or window name.') } }
            }
          }
        },
        sttEndpoints: endpointMap(STT_REMOTE_PROVIDERS, 'transcription', 'Per-provider endpoint, model and key for transcription. Use "compatible" for any OpenAI-compatible /audio/transcriptions server (self-hosted Whisper, vLLM, LocalAI...).'),
        costLimitUsd: { type: ['number', 'null'], description: 'Estimated cost limit per review in USD. null means no limit. Default 1.', minimum: 0.01, maximum: 1000 }
      }
    },
    organizer: {
      type: 'object',
      description: '"Organize findings": how the findings of a review are grouped by an LLM.',
      properties: {
        runner: { type: 'string', description: 'codex / claude-code run your own CLI login; api:<provider> calls the API directly with your key.', enum: ['codex', 'claude-code', ...LLM_API_PROVIDERS.map((p) => `api:${p}`)] },
        cliModels: {
          type: 'object',
          description: 'Model passed to the CLI runners. Omit to use the CLI\'s default.',
          additionalProperties: false,
          properties: {
            codex: str('Model for the Codex runner (codex exec -m).', { maxLength: 200 }),
            'claude-code': str('Model for the Claude Code runner (claude --model).', { maxLength: 200 })
          }
        },
        endpoints: endpointMap(LLM_API_PROVIDERS, 'LLM', 'Per-provider endpoint, model and key for api:<provider> runners. Use "compatible" for any OpenAI-compatible /chat/completions server (Ollama, LM Studio, vLLM...).')
      }
    },
    decision: {
      type: 'object',
      description: 'Decision model (System One compatible API) used by your coding agent to check each finding after implementing it. Ferret does not judge by itself: when enabled, agents get FERRET_DECISION_URL (a local relay that adds the key and logs usage), FERRET_DECISION_MODEL and FERRET_DECISION_IMAGES, and feedback.md gets an acceptance check that judges each finding once (the agent may improve it once more from that result, then hands it to you). Presets only prefill fields; any compatible API works with "custom".',
      properties: {
        enabled: bool('Use the decision model (local relay + a one-judgement-per-finding acceptance check in the agent prompt).', { default: false }),
        preset: { type: 'string', description: 'Which preset prefilled the fields: ollama (local, free), cloudflare (Workers AI), vercel (AI Gateway), typesafe, openai (OpenAI Decisions API, gpt-6-luna; reads images), custom.', enum: DECISION_PRESET_IDS, default: 'ollama' },
        endpoint: str('Full request URL. {account_id} and {model} are replaced. e.g. "http://localhost:11434/v1/systemone", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/{model}". Omit for the preset.', { pattern: '^https?://' }),
        model: str('Model name, e.g. "clef-flash", "clef", "typesafe-ai/jev", "jev-latest", "gpt-6-luna".', { maxLength: 200 }),
        imageFormat: { type: 'string', description: 'How the agent encodes images: "base64" (plain, Ollama) or "data-uri" (data:image/jpeg;base64,..., required by Cloudflare Workers AI). Omit for the preset. Passed to agents as FERRET_DECISION_IMAGE_FORMAT.', enum: ['base64', 'data-uri'] },
        images: bool('Send BEFORE/AFTER screenshots. Only models that read images (Clef / Clef Flash) should have this on. Omit for the preset.'),
        passThreshold: { type: 'number', description: 'A finding passes when P(done) is at least this and the choice is "done". 0.5-0.99, default 0.7. Shown to the agent as {{threshold}}.', minimum: 0.5, maximum: 0.99 },
        timeoutMs: { type: 'integer', description: 'Relay timeout per request in milliseconds (1000-600000). Default 120000.', minimum: 1000, maximum: 600000 },
        apiKeyEnv: str('Name of an environment variable that holds the API key (e.g. CLOUDFLARE_API_TOKEN, AI_GATEWAY_API_KEY, TYPESAFE_API_KEY, OPENAI_API_KEY). Looked up in the app\'s environment, then the project .env, then ~/.ferret/.env.', { pattern: ENV_NAME }),
        apiKey: str('WARNING: plaintext API key stored in this file. Prefer apiKeyEnv or the key field in the Settings page. Takes precedence over apiKeyEnv and the saved key. Never passed to agents.', { maxLength: 500 }),
        pricing: {
          type: 'object',
          description: 'Optional prices used to estimate cost in the usage footer when the response has no cost. Omit to show "—".',
          additionalProperties: false,
          properties: {
            inputPer1M: { type: 'number', description: 'USD per 1M input tokens.', minimum: 0 },
            outputPer1M: { type: 'number', description: 'USD per 1M output tokens.', minimum: 0 }
          }
        },
        ...AUTH_FIELDS
      }
    },
    browserExtensions: {
      type: 'array',
      description: `Chrome extensions loaded into the built-in browser only (never into Ferret's own windows). Each entry is an unpacked extension folder that contains manifest.json (Manifest V2 or V3). Extensions can read and change every page you open in the built-in browser and use its sign-ins, so add only extensions you trust. At most ${MAX_BROWSER_EXTENSIONS}. Use Settings > Browser extensions to add a folder or import one from Chrome, Edge or Brave.`,
      items: {
        type: 'object',
        description: 'One extension folder.',
        required: ['path'],
        additionalProperties: false,
        properties: {
          path: str('Absolute path of the unpacked extension folder (the folder with manifest.json). Packed .crx files are not supported.', { maxLength: 1000 }),
          enabled: bool('Load this extension. Omit for true.'),
          reload: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Reload signal. Change this number (for example to the current Unix time in seconds) after editing or rebuilding the extension, and Ferret loads it again from the folder and reloads the open page. Ferret does not watch the folder by itself.' }
        }
      }
    },
    github: {
      type: 'object',
      description: 'GitHub repositories created from a project (right-click a project > Create a private repository on GitHub). They are always private.',
      additionalProperties: false,
      properties: {
        defaultOwner: str('Account or organization where new repositories go by default. Omit to use your own account. The list to choose from comes from gh (your account and your organizations).', { pattern: '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$' })
      }
    },
    crashReports: bool('Send crash reports to Sentry. Reports never include API keys, file contents or recordings.', { default: true }),
    crashReportsNoticeShown: bool('The first-run crash report notice has been shown.'),
    autoUpdate: bool('Download new versions in the background, check each one against the signed SHA256SUMS, and install it the next time Ferret closes (Restart to update installs it right away). When off, nothing is downloaded or installed until you choose to.', { default: true }),
    mobileRemote: {
      type: 'object',
      description: 'Phone remote: watch and steer the terminals from a phone browser on the same Wi-Fi or over Tailscale. When enabled, Ferret listens on all network interfaces and shows a link and QR code in Settings > Phone remote; the link carries a secret that Ferret keeps outside this file. Anyone with that link can type into your terminals, so turn it on only on networks you trust (traffic is plain HTTP; over Tailscale it is encrypted).',
      additionalProperties: false,
      properties: {
        enabled: bool('Listen for the phone. Omit or false to keep it off.', { default: false }),
        port: { type: 'integer', description: 'TCP port to listen on. If it is in use, Settings shows an error; pick another port.', minimum: MOBILE_REMOTE_MIN_PORT, maximum: MOBILE_REMOTE_MAX_PORT, default: MOBILE_REMOTE_DEFAULT_PORT }
      }
    },
    onboarding: {
      type: 'object',
      description: 'First-run setup progress. Remove this object to show the setup again.',
      additionalProperties: false,
      properties: {
        completedAt: str('When setup was finished (ISO 8601).', { maxLength: 64 }),
        dismissedAt: str('When setup was closed early (ISO 8601).', { maxLength: 64 }),
        lastStep: { type: 'string', description: 'Step to resume from.', enum: ONBOARDING_STEPS }
      }
    }
  }
}

/** settings.json の上の階層で、アプリが意味を知っている項目（それ以外は「知らない項目」としてそのまま残す） */
export function knownSettingsKeys(): Set<string> {
  return new Set([...Object.keys(SETTINGS_SCHEMA.properties ?? {}), ...STATE_KEYS, ...LEGACY_KEYS, 'projects'])
}

interface SchemaIssue {
  /** JSON Pointer 風の場所（/capture/keepDays） */
  path: string
  message: string
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

/**
 * 小さな検証（このスキーマで使う語だけ: type / enum / properties / additionalProperties / items /
 * required / pattern / minimum / maximum / maxLength）。外部の変更を取り込む前に、型の違う値を知らせるため。
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = ''): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  const at = path || '/'
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) return [{ path: at, message: `expected ${types.join(' or ')}, got ${actual}` }]
  }
  if (schema.enum && !schema.enum.includes(value)) issues.push({ path: at, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` })
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push({ path: at, message: `does not match ${schema.pattern}` })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path: at, message: `longer than ${schema.maxLength} characters` })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path: at, message: `must be >= ${schema.minimum}` })
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path: at, message: `must be <= ${schema.maximum}` })
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => issues.push(...validateAgainstSchema(item, schema.items!, `${path}/${i}`)))
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (obj[key] === undefined) issues.push({ path: at, message: `missing required "${key}"` })
    for (const [key, v] of Object.entries(obj)) {
      // undefined は JSON に書かれない（実行中の値を確かめるときだけ来る）
      if (v === undefined) continue
      const child = schema.properties?.[key]
      if (child) issues.push(...validateAgainstSchema(v, child, `${path}/${key}`))
      else if (schema.additionalProperties === false) issues.push({ path: `${path}/${key}`, message: 'unknown property' })
      else if (typeof schema.additionalProperties === 'object') issues.push(...validateAgainstSchema(v, schema.additionalProperties, `${path}/${key}`))
    }
  }
  return issues
}

/** 配布するスキーマのファイルの中身 */
export function settingsSchemaText(): string {
  return `${JSON.stringify(SETTINGS_SCHEMA, null, 2)}\n`
}
