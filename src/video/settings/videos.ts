import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default of settings `videos.root` (the master folder). */
export const DEFAULT_VIDEOS_ROOT = '~/Movies/Ferret';

/** `videos.root` as an absolute path: a leading `~` is the user's home. Empty / non-string → the default. */
export function resolveVideosRoot(root: unknown, home: string = homedir()): string {
  const r = typeof root === 'string' && root.trim() ? root.trim() : DEFAULT_VIDEOS_ROOT;
  if (r === '~') return home;
  if (r.startsWith('~/') || r.startsWith('~\\')) return join(home, r.slice(2));
  return r;
}
