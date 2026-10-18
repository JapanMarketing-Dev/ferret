/**
 * `ferret-browser`（API で browser-use の Agent を動かし、内蔵ブラウザで依頼をやり切る）の中身。
 * browser-use を入れたときの Python（uv tool の環境）で動かす。LLM は Ferret の中継（/llm/<接続先>）を通すので、キーはここに無い。
 */

export const BROWSER_AGENT_PY = 'ferret_browser_agent.py'
export const BROWSER_BIN_NAME = 'ferret-browser'

export const BROWSER_AGENT_SCRIPT = `# Ferret が書くファイル（ferret-browser）。手で直さない（Ferret が書き直す）。
"""ferret-browser: run a browser-use Agent (API mode) in Ferret's built-in browser.

The LLM calls go through Ferret's relay, which adds the API key you saved in Ferret.
The key never reaches this process. Without a key, drive the browser step by step
from your subscription agent with the browser-use CLI instead (see the ferret-browser skill).
"""
import argparse
import asyncio
import json
import os
import sys
import urllib.request


def fail(message, code=2):
    print(f"ferret-browser: {message}", file=sys.stderr)
    sys.exit(code)


def main():
    parser = argparse.ArgumentParser(prog="ferret-browser", description="Let a browser-use agent (API mode) do a task in Ferret's built-in browser.")
    parser.add_argument("task", nargs="*", help="what to do, in plain words")
    parser.add_argument("--provider", default=os.environ.get("FERRET_BROWSER_LLM_PROVIDER", "auto"), help="anthropic, openai, gemini, openrouter, vercel-gateway, ollama, lmstudio (default: the first one with a key in Ferret)")
    parser.add_argument("--model", default=os.environ.get("FERRET_BROWSER_LLM_MODEL"), help="model name (default: the provider's default)")
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--no-vision", action="store_true", help="do not send screenshots to the model (automatic for local models)")
    parser.add_argument("--list-providers", action="store_true", help="show the providers Ferret has keys for")
    args = parser.parse_args()

    base = os.environ.get("FERRET_BROWSER_CDP_URL", "").rstrip("/")
    if not base:
        fail("run this inside a Ferret terminal (FERRET_BROWSER_CDP_URL is not set)")
    try:
        providers = json.loads(urllib.request.urlopen(f"{base}/llm/providers", timeout=10).read())["providers"]
    except Exception as err:  # noqa: BLE001
        fail(f"could not reach Ferret ({err}). Is Ferret still running?")
    if args.list_providers:
        for p in providers:
            print(f"{p['id']}\\t{p['model']}\\t{p['label']}")
        return
    task = " ".join(args.task).strip()
    if not task:
        parser.print_usage()
        fail("give the task, e.g. ferret-browser \\"find the pricing page of example.com and summarise the plans\\"")
    if args.provider == "auto":
        if not providers:
            fail("no API key in Ferret. Add one in Ferret's settings (AI keys), or drive the browser from your subscription agent with the browser-use CLI.")
        chosen = providers[0]
    else:
        chosen = next((p for p in providers if p["id"] == args.provider), None)
        if chosen is None:
            fail(f"no API key in Ferret for {args.provider}. Available: {', '.join(p['id'] for p in providers) or 'none'}")
    model = args.model or chosen["model"]
    if not model:
        fail(f"give --model for {chosen['id']}")

    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    os.environ.setdefault("BROWSER_USE_LOGGING_LEVEL", "info")
    try:
        from browser_use import Agent, Browser, ChatAnthropic, ChatOpenAI
    except Exception as err:  # noqa: BLE001
        fail(f"browser-use is not available in this Python ({err}). Install it: uv tool install --python 3.12 browser-use")

    relay = f"{base}/llm/{chosen['id']}"
    if chosen["kind"] == "anthropic-messages":
        llm = ChatAnthropic(model=model, api_key="ferret-relay", base_url=relay)
    else:
        # OpenAI 互換でも、OpenAI 以外（Gemini・OpenRouter・端末内のモデル）は frequency_penalty を受け付けないものがある
        extra = {} if chosen["id"] == "openai" else {"frequency_penalty": None}
        llm = ChatOpenAI(model=model, api_key="ferret-relay", base_url=relay, **extra)

    async def run():
        browser = Browser(cdp_url=base, keep_alive=True)
        # 端末内のモデル（Ollama・LM Studio）は画像を受け付けないことが多いので、画面の画像は送らない
        use_vision = not (args.no_vision or chosen["id"] in ("ollama", "lmstudio"))
        agent = Agent(task=task, llm=llm, browser=browser, use_vision=use_vision)
        print(f"ferret-browser: {chosen['label']} / {model} — working in Ferret's built-in browser", file=sys.stderr)
        try:
            history = await agent.run(max_steps=args.max_steps)
        finally:
            # 内蔵ブラウザは閉じない（Ferret のもの）。つないだ口だけを閉じる
            try:
                await browser.stop()
            except Exception:  # noqa: BLE001
                pass
        result = history.final_result()
        print(result if result else "(no final result)")
        return 0 if history.is_done() and history.is_successful() is not False else 1

    sys.exit(asyncio.run(run()))


if __name__ == "__main__":
    main()
`

/** POSIX の入口（browser-use の uv tool の Python を探して、上の Python を動かす） */
export function browserBinPosix(scriptPath: string): string {
  const quoted = `'${scriptPath.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
# Ferret が書くファイル（ferret-browser）。手で直さない
PY="\${FERRET_BROWSER_USE_PYTHON:-}"
if [ -z "$PY" ] && command -v uv >/dev/null 2>&1; then
  D="$(uv tool dir 2>/dev/null)"
  [ -n "$D" ] && [ -x "$D/browser-use/bin/python" ] && PY="$D/browser-use/bin/python"
fi
if [ -z "$PY" ]; then
  for C in "\${XDG_DATA_HOME:-$HOME/.local/share}/uv/tools/browser-use/bin/python"; do
    [ -x "$C" ] && PY="$C" && break
  done
fi
if [ -z "$PY" ]; then
  echo "ferret-browser: browser-use is not installed. Install it: uv tool install --python 3.12 browser-use" >&2
  exit 127
fi
exec "$PY" -I ${quoted} "$@"
`
}

/** Windows の入口 */
export function browserBinCmd(scriptPath: string): string {
  return `@echo off\r
rem Ferret が書くファイル（ferret-browser）。手で直さない\r
set "PY=%FERRET_BROWSER_USE_PYTHON%"\r
if "%PY%"=="" set "PY=%APPDATA%\\uv\\tools\\browser-use\\Scripts\\python.exe"\r
if not exist "%PY%" (\r
  echo ferret-browser: browser-use is not installed. Install it: uv tool install --python 3.12 browser-use 1>&2\r
  exit /b 127\r
)\r
"%PY%" -I "${scriptPath}" %*\r
`
}
