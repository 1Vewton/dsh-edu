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
# 1) from git (recommended)
dsh plugin --profile web add github:1Vewton/dsh-edu

# or from a checkout of this repo
pnpm pack                                  # produces dsh-edu-mode-0.1.0.tgz
dsh plugin --profile web add ./dsh-edu-mode-0.1.0.tgz
```

> **How you install matters.** Use a tarball or a git install: those unpack a real directory into the profile's `node_modules`. Do *not* use `dsh plugin add <directory>` — that is pnpm's `link:`, and Node resolves the symlink to the source directory, so the plugin's `@deepseek-ai/*` imports bind to the source checkout's own `node_modules` and load a **second copy of cordis / dsh-tools**, which the harness cannot recognise as a plugin. Developing inside a DSH source checkout (`pnpm dsh` + `--patch`) is unaffected.

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

## Development

```sh
pnpm install
pnpm build      # src/*.ts -> lib/*.js (lib/ is committed; rebuild and repack after changes)
pnpm test       # 35 unit tests: grading, paths, course-file rendering, state folding, config
```

Source layout:

```
src/index.ts   plugin entry: the EduMode service, the edu:policy prompt section, /edu, the state machine
src/policy.ts  the default teaching protocol (overridable through config.policy)
src/course.ts  the edu_course / edu_notes tools
src/quiz.ts    pure grading functions + the edu_quiz tool
src/store.ts   course-file access through ctx.fs, subject to the sandbox
src/paths.ts   pure helpers: slugification, file layout, markdown rendering
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
