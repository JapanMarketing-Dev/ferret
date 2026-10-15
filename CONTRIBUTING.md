# Contributing

Issues and pull requests are welcome. Japanese or English is fine.

## How to contribute

- Report bugs and ideas in Issues. Steps to reproduce, your OS and the MOVIE-ADE version (shown in the footer) help a lot.
- Before attaching recordings, screenshots or logs, check that they show no API keys, tokens, or personal or customer information.
- For large changes, open an issue first to discuss the approach.
- Open pull requests against `main`. `main` is the only branch.

## Setup

```sh
pnpm install
pnpm dev
```

Before sending a pull request, make sure type checking and unit tests pass:

```sh
pnpm typecheck
pnpm test:unit
```

## Ground rules

- Never put API keys or tokens in source code or tests. Keep development keys in the git-ignored `.env`.
- Do not add features that need a server or API key provided by the developers. Anything that costs money must run on the user's own key, CLI subscription or GPU.
- When you port code from another project, check its license, note the source at the top of the file, and add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not port copyleft code such as GPL.
- Contributions are released under the same [MIT License](LICENSE) as this repository.
- Do not add a workflow that always fails until someone adds a secret or turns on a repository setting. Check for it in the first step, print a `::notice`, and skip the steps that need it (see `dependency-review.yml`; `test/unit/release-policy.test.ts` checks it). Workflows hold no signing key or R2 token: signing and publishing are local steps (README, Releases).
- Unit tests run on macOS, Windows and Linux. Skip Windows when a test checks file permission bits, build paths with `path.join` instead of `/`, and create large numbers of files in batches rather than in one `Promise.all` (Windows runs out of file handles).
- Code scanning (CodeQL) must stay at zero alerts. Escape every value you put into a `RegExp` (all special characters and `\`), never build code strings from values (pass data instead), strip HTML tags or comments by repeating the `replace` until nothing changes (or use a parser), and serve files only from an allowlist or a path checked to stay inside its folder. `test/unit/codeql-patterns.test.ts` catches the common cases; `bash scripts/codeql-local.sh` runs the same queries as CI.
