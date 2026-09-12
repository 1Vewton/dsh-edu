# dsh-edu-mode — education mode

English | [中文](README.zh.md)

An **education mode** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): inside this mode the agent's deliverable is *your understanding* of a subject. It gathers real sources, teaches the material properly, writes the class notes down, and quizzes you before claiming you have learned anything.

This is a real plugin, not a prompt snippet: a switchable session mode, a teaching protocol injected into every model request, three tools the model has to use, and course files that survive the session.

## What it does

| Stage | Behaviour | Enforced by |
| --- | --- | --- |
| 1. Gather | `web_search` / `web_fetch` for authoritative sources (textbooks, university course pages, standards, papers), with titles and URLs recorded; parallel subagents when a lesson needs many | teaching protocol + the existing web tools |
| 2. Explain | why it matters → intuition/analogy → precise definition (every symbol defined before use) → derivation → a fully worked example → usual misconceptions → how it connects | teaching protocol |
| 3. Notes | after each lesson, `edu_notes` writes the explanation, key points, pitfalls and sources into the course notes file | `edu_notes` tool |
| 4. Quiz | at the end of each lesson, `edu_quiz` asks you questions in the conversation's own question UI, grades them, and re-teaches anything you missed with new examples | `edu_quiz` tool |
| 5. Progress | once a module's quizzes back it, `edu_course` checks it off; progress persists across sessions | `edu_course` tool |

The three tools:

- **`edu_course`** — `open` creates or rewrites the syllabus (goal, level, module checklist, sources) and makes it the session's active course; `status` reports progress and the next module; `complete` checks a module off.
- **`edu_notes`** — writes the class notes for one lesson (body + key points + misconceptions + sources). A second write for the same lesson is refused unless `replace: true` is passed.
- **`edu_quiz`** — asks, collects answers through the interactive question UI, grades, and logs the result. Choice questions are graded automatically (single- and multi-select); open questions are handed back for the model to judge. With no interactive channel (headless, ACP, a subagent), it degrades gracefully: the questions come back to the model to ask in chat instead of failing.

## Course files

Written under `edu-notes/<course>/` in the session workspace:

```
edu-notes/linear-algebra/
├── syllabus.md   # goal, level, module checklist (- [ ] / - [x]), sources
├── notes.md      # the class notes, one section per lesson
└── quizzes.md    # the quiz log, one section per quiz, with scores and mistakes
```

Course names are slugified (CJK preserved, path separators removed), so `/edu 线性代数` yields `edu-notes/线性代数/`.

## Install

The plugin is a standard DSH bundle (`dsh.bundle` + `cordis.patch.yml`). The built `lib/` is committed, so **no build-script permission is needed**.

```sh
# 1) from npm, once a release exists
dsh plugin --profile web add dsh-edu-mode

# 2) from the tarball attached to a GitHub Release
dsh plugin --profile web add ./dsh-edu-mode-0.1.0.tgz

# 3) straight from git
dsh plugin --profile web add github:1Vewton/dsh-edu
```

> **How you install matters.** Use npm, a tarball or a git install: those unpack a real directory into the profile's `node_modules`. Do *not* use `dsh plugin add <directory>` — that is pnpm's `link:`, and Node resolves the symlink to the source directory, so the plugin's `@deepseek-ai/*` imports bind to the source checkout's own `node_modules` and load a **second copy of cordis / dsh-tools**, which the harness cannot recognise as a plugin. Developing inside a DSH source checkout (`pnpm dsh` + `--patch`) is unaffected.

When running from a source checkout, replace `dsh` with `pnpm dsh`. Verify the layer without starting a server:

```sh
dsh --profile web --dump-config     # expect a "# == dsh-edu-mode" section
```

The profile's server must be restarted (e.g. `pnpm dsh web`) to load it. To uninstall: `dsh plugin --profile web remove dsh-edu-mode`.

## Configuration

The plugin's `config` in `cordis.patch.yml`, validated strictly at load (a typo fails loudly instead of silently defaulting):

```yaml
- insert:
    - id: edu-mode
      name: 'dsh-edu-mode'
      config:
        notesDir: edu-notes        # workspace-relative course-file root
        maxQuizQuestions: 6        # ceiling on one edu_quiz call
        passRatio: 0.8             # pass line for the auto-graded part
        # policy: |                # replace the built-in teaching protocol wholesale
```

## Usage

`/edu` is the switch:

| Command | Effect |
| --- | --- |
| `/edu linear algebra` | turns education mode on, sets the course, and sends your text to the model as the request |
| `/edu` | turns the mode on with no course yet; the model asks what you want to study |
| `/edu status` | shows the current state and course |
| `/edu off` | leaves education mode |

A typical opener:

```
/edu linear algebra, starting from determinants, my basics are shaky
```

After that the protocol drives the session: gather sources → teach one module → write the notes → quiz → re-teach whatever the quiz exposed. You can interrupt at any point ("explain that again", "harder questions", "skip this section").

Mode state lives in the session log (the `edu/mode` event, last one wins), so resuming or forking a session restores the mode and its course; course progress lives in the workspace files and is therefore also available across sessions.

## Releasing

Releases run on GitHub Actions (`.github/workflows/release.yml`): pushing a version tag builds, tests, publishes to npm, and creates a GitHub Release with the packed tarball attached.

```sh
# 1) bump and commit
npm version patch --no-git-tag-version     # or edit package.json
pnpm build && pnpm test                    # keeps lib/ in step with src/
git commit -am "chore: release v0.1.1"
git push

# 2) tag to publish
git tag v0.1.1 && git push origin v0.1.1
```

**One-time setup:** create an npm **Automation** token (npmjs.com → Access Tokens) and add it as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions). Without it the workflow fails loudly at the publish step instead of skipping silently.

The workflow refuses to release: a tag that disagrees with the `package.json` version, a committed `lib/` that no longer matches `src/` (so the published build can never be stale), failing unit tests, or a version already on npm. It publishes with `npm publish --access public --provenance`, so the npm page carries a provenance attestation naming this workflow run as the build, and the GitHub Release carries the same tarball.

Manual dispatches from the Actions tab default to `dry_run = true`, which builds, tests and packs without publishing.

> Later, you can move to npm [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers/): once the package exists on npm, add a trusted publisher for `1Vewton` / `dsh-edu` / `release.yml` in the package's Settings → Trusted publishing, then delete `NPM_TOKEN` (the workflow already requests `id-token: write`). The first publish still needs a token, because trusted publishing can only be configured for a package that already exists.

## Listing on dsh-market

[`dsh-market`](https://github.com/dsh-market/dsh-market) — the plugin market inside DSH — **installs only from sources listed in the curated registry**, and that catalog is generated from `data/plugins/*.yml` in [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (site: https://awesome-dsh-plugin.com). Getting listed is therefore **one pull request that adds one file**, not a submission to a service.

This repository keeps its copy of that entry at `contrib/awesome-dsh-plugin/1Vewton__dsh-edu.yml`, and `tests/marketplace.test.js` checks it against the registry's stated rules (repository URL, category, description format, and whether the description's claims match the code). To submit, paste it as `data/plugins/1Vewton__dsh-edu.yml` in the registry repository and open the PR; both READMEs there are generated, so **do not edit them by hand**.

The registry's hard requirements, against this repository's current state:

| Requirement | State |
| --- | --- |
| `package.json` declares a `dsh.bundle` manifest (what makes it installable) | ✅ |
| Real, working code — not a placeholder or README-only repo | ✅ |
| Repository at least **1 day old** (checked automatically) | ⏳ created 2026-09-12 03:56 UTC, so it qualifies after **2026-09-13 04:00 UTC** |
| The [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic on the repository | ⬜ must be added by hand in the repo's About panel |
| Description is accurate (reviewers check it against the code) | ✅ it claims only the three tools that exist here |
| Category fits what the plugin does | `agi` (agent behaviour/mode plugins; a maintainer re-files a near miss rather than rejecting it) |

Recommended, not required: publish to npm (storefronts then show download counts and install faster), or attach a prebuilt tarball to a GitHub Release and point the entry's `tarball:` field at it. Both are ready here — the release workflow attaches `dsh-edu-mode-0.1.0.tgz` **and** a version-free `dsh-edu-mode.tgz`, because `releases/latest/download/<name>` takes the filename literally and a versioned name would 404 after the next release.

## Development

```sh
pnpm install
pnpm check      # = pnpm build + pnpm test (use this after editing src/)
pnpm test       # 108 tests, ~0.3s, against lib/ — the artifact an install loads
```

The suite runs against `lib/`, not `src/`, and that is the point: `lib/` is
what a profile imports, so either rebuild first (`pnpm check`) or you are testing
the previous build.

| File | What it pins down |
| --- | --- |
| `tests/paths.test.js` | course-name slugification, course file layout, markdown rendering, module checkbox parse/toggle |
| `tests/quiz.test.js` | grading rules: single/multi-select, open questions, skipped answers, score and pass line, report rendering |
| `tests/store.test.js` | course-file access: relative-path containment, workspace resolution, sandbox policy, `fs/observed`, append semantics |
| `tests/tools.test.js` | the three tools end to end: syllabus, progress, notes, quiz log, and every degradation path |
| `tests/plugin.test.js` | wiring on a real cordis `Context`: services, guidance section, `/edu`, the state machine, the session-log contract |
| `tests/bundle.test.js` | the bundle contract: patch row, `files`, entry points, and "every runtime bare import is a peer" |
| `tests/mode.test.js` | configuration validation and `edu/mode` folding |

CI (`.github/workflows/ci.yml`) runs the same thing on ubuntu and windows, Node 22 and 24: `pnpm install --frozen-lockfile` → `pnpm build` plus a check that the committed `lib/` still matches `src/` → `pnpm test`. The Windows leg is not decoration: the plugin resolves workspace-relative paths and writes course files. `.gitattributes` normalizes text to LF so the `lib/` comparison holds on every platform.

Source layout:

```
src/index.ts   plugin entry: the EduMode service, the edu:policy prompt section, /edu, the state machine
src/policy.ts  the default teaching protocol (overridable through config.policy)
src/course.ts  the edu_course / edu_notes tools
src/quiz.ts    pure grading functions + the edu_quiz tool
src/store.ts   course-file access through ctx.fs, subject to the sandbox
src/paths.ts   pure helpers: slugification, file layout, markdown rendering
tests/         the suites plus tests/helpers.mjs (scratch workspace, fake session/fs/tool registry)
```

An installed profile holds a copy of the bundle: after changing the code, `remove` and `add` it again.

## Design notes

- **State in the session log, not in plugin memory**, so resume and fork need no live mirror. A switch made mid-turn waits for the next step boundary before being appended (the approach plan mode uses), which avoids re-entering the session while an append is being published.
- **Files go through `ctx.fs`** with the session's sandbox policy resolved per call, so writes obey the deployment's sandbox mode (`workspace-write` cannot escape the workspace). Because this plugin only appends to, or precisely toggles, files it owns, it passes no read-before-write intent; it emits `fs/observed` instead, keeping the model's own `write`/`edit` calls coherent.
- **Grading is pure** and lives in one place: a single-select question is correct when it matches any declared acceptable label, a multi-select question needs exactly the declared set (a non-empty proper subset scores half), an open question is never auto-graded, and an unanswered question still counts in the denominator.
- **No UI cards**: the quiz reuses the conversation's built-in question component, so no client build is involved. Mode state is visible through the `/edu` receipts and the session log — an input-bar chip would need a client plugin and is left as the natural next step.

## Limitations

- Mode state is per session; `/edu off` does not affect other sessions.
- Only machine-checkable questions are graded automatically; open questions depend on the model's judgement, which receives the reference answer with the response.
- Notes are keyed by course name: two courses with the same name are one course, and renaming a course starts a new one.
- Education mode does not restrict other tools — the protocol states that understanding is the deliverable, but the model can still be asked to do something else.

## License

MIT
