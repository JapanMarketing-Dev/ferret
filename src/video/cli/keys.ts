// API keys never live in settings.json (docs/11): settings hold `apiKeyRef` names, and the desktop app injects the
// secrets from the OS keychain as FERRET_VIDEO_<REF>_API_KEY into CLI children and agent terminals.

/** "openai" → FERRET_VIDEO_OPENAI_API_KEY; "my-key.1" → FERRET_VIDEO_MY_KEY_1_API_KEY */
export function keyEnvName(ref: string): string {
  return `FERRET_VIDEO_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}_API_KEY`;
}

/**
 * Key for a decision/image provider: FERRET_VIDEO_DECIDE_API_KEY (decision only) → the apiKeyRef's env → the provider's own
 * FERRET_VIDEO_<PROVIDER>_API_KEY → the vendor's usual variable (OPENAI_API_KEY, GEMINI_API_KEY, TYPESAFE_API_KEY).
 */
export function apiKeyFor(env: NodeJS.ProcessEnv, ref: string | undefined, provider: string, o: { decision?: boolean } = { decision: true }): string | undefined {
  const vendor: Record<string, string> = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', typesafe: 'TYPESAFE_API_KEY' };
  const names = [
    ...(o.decision !== false ? ['FERRET_VIDEO_DECIDE_API_KEY'] : []),
    ...(ref ? [keyEnvName(ref)] : []),
    keyEnvName(provider),
    ...(vendor[provider] ? [vendor[provider]!] : []),
  ];
  for (const n of names) {
    const v = env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}
