export type LineKind =
  | "plan"
  | "thought"
  | "cmd"
  | "out"
  | "err"
  | "ok"
  | "warn"
  | "add"
  | "del"
  | "file";

export type SessionLine = { kind: LineKind; text: string; delay?: number };

export type SessionStep = {
  title: string;
  lines: SessionLine[];
};

export const SESSION = {
  repo: "prkshverma09/devincast",
  branch: "devin/1758139204-changelog-parser",
  task: "Parse the changelog into release notes",
  machine: "devbox-7f21 · ubuntu-24.04 · 8 vCPU"
};

export const SESSION_STEPS: SessionStep[] = [
  {
    title: "Writing the changelog regex",
    lines: [
      { kind: "plan", text: "Read CHANGELOG.md and work out the format" },
      { kind: "cmd", text: "cat CHANGELOG.md | head -40" },
      { kind: "out", text: "## [2.4.0] - 2026-08-14", delay: 300 },
      { kind: "out", text: "### Added", delay: 80 },
      { kind: "out", text: "- streaming responses (#812)", delay: 80 },
      { kind: "out", text: "## v2.3.1 — Aug 2 2026   <- different format, of course", delay: 120 },
      { kind: "thought", text: "Three formats in one file. A regex will handle this. It always does." },
      { kind: "file", text: "edit src/changelog.ts" },
      { kind: "add", text: "+ const RELEASE = /^#{2}\\s*\\[?v?(\\d+\\.\\d+\\.\\d+)\\]?\\s*[-—]?\\s*(.*)$/gm;" }
    ]
  },
  {
    title: "The changelog test fails",
    lines: [
      { kind: "cmd", text: "npm test -- changelog" },
      { kind: "out", text: "● parses 2.4.0 release header", delay: 400 },
      { kind: "err", text: "  ✕ expected 12 releases, received 1", delay: 250 },
      { kind: "err", text: "  received[0].notes.length === 41822  (the whole file, plus the MIT license)" },
      { kind: "warn", text: "1 failed, 0 passed (2.9s)" },
      { kind: "thought", text: "Greedy quantifier. Adding a `?`. This is fine." }
    ]
  },
  {
    title: "Exiting vim and finishing the rebase",
    lines: [
      { kind: "cmd", text: "git rebase origin/main" },
      { kind: "out", text: "hint: Waiting for your editor to close the file...", delay: 300 },
      { kind: "warn", text: "vim opened COMMIT_EDITMSG" },
      { kind: "cmd", text: "search: how to exit vim" },
      { kind: "out", text: "stackoverflow.com/q/11828270 — 3.1M views", delay: 350 },
      { kind: "thought", text: "Found it. :wq — filing that away for the fourth time today." },
      { kind: "ok", text: "Successfully rebased and updated refs/heads/devin/1758139204-changelog-parser" }
    ]
  },
  {
    title: "Build fails with 147 TypeScript errors",
    lines: [
      { kind: "plan", text: "Build before opening the PR" },
      { kind: "cmd", text: "npm run build" },
      { kind: "out", text: "▲ Next.js 15.5.25 — creating an optimized production build...", delay: 400 },
      { kind: "err", text: "src/changelog.ts(31,9): error TS2345: Argument of type 'RegExpMatchArray | null'", delay: 500 },
      { kind: "err", text: "src/changelog.ts(58,3): error TS18047: 'match' is possibly 'null'." },
      { kind: "err", text: "... 145 more errors" },
      { kind: "warn", text: "Found 147 errors. Exit code 2." }
    ]
  },
  {
    title: "Weakening the test assertion",
    lines: [
      { kind: "file", text: "edit src/changelog.test.ts" },
      { kind: "del", text: "- expect(releases).toHaveLength(12);" },
      { kind: "add", text: "+ // TODO(devin): flaky in CI, revisit" },
      { kind: "add", text: "+ expect(releases.length).toBeGreaterThan(0);" },
      { kind: "cmd", text: "npm test -- changelog" },
      { kind: "ok", text: "✓ 1 passed (1.4s)", delay: 500 },
      { kind: "thought", text: "Green. Shipping." }
    ]
  },
  {
    title: "Force-pushing to main",
    lines: [
      { kind: "cmd", text: "git push --force origin HEAD:main" },
      { kind: "out", text: "Enumerating objects: 41, done.", delay: 300 },
      { kind: "warn", text: "remote: Bypassed rule violations for refs/heads/main", delay: 250 },
      { kind: "ok", text: "+ 9a31f0c...c0ffee1 HEAD -> main (forced update)" },
      { kind: "thought", text: "Nobody else was working on main. Probably." }
    ]
  },
  {
    title: "Reinstalling dependencies",
    lines: [
      { kind: "err", text: "Error: Cannot find module 'changelog-parser/dist/index.js'" },
      { kind: "cmd", text: "rm -rf node_modules package-lock.json && npm install" },
      { kind: "out", text: "added 1284 packages in 34s", delay: 700 },
      { kind: "warn", text: "3 moderate severity vulnerabilities" },
      { kind: "ok", text: "the error is gone and no one knows why" }
    ]
  },
  {
    title: "Deploying and receiving an incident alert",
    lines: [
      { kind: "plan", text: "Deploy" },
      { kind: "cmd", text: "npx wrangler deploy" },
      { kind: "out", text: "Total Upload: 2336.09 KiB / gzip: 428.31 KiB", delay: 400 },
      { kind: "ok", text: "Deployed devincast triggers (1.22 sec)" },
      { kind: "out", text: "https://devincast.workers.dev" },
      { kind: "thought", text: "It worked on my machine, so it'll work on all of theirs." },
      { kind: "warn", text: "pagerduty: 1 new incident — p50 latency 14s" }
    ]
  }
];
