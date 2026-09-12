/**
 * Pure course-file layout and rendering. Nothing here touches the filesystem,
 * the clock, or the plugin context: paths and markdown are computed from
 * arguments so the same functions serve the tools, the tests, and a future UI.
 *
 * Layout written under the workspace-relative notes root:
 *
 * ```text
 * <notesDir>/<course>/
 *   syllabus.md   course goal, module checklist, sources   (edu_course)
 *   notes.md      the class notes, one section per lesson  (edu_notes)
 *   quizzes.md    the quiz log, one section per quiz       (edu_quiz)
 * ```
 */

/** The three files that make up one course directory. */
export interface CourseLayout {
  /** Workspace-relative course directory, no trailing slash. */
  dir: string
  /** Workspace-relative syllabus path. */
  syllabus: string
  /** Workspace-relative class-notes path. */
  notes: string
  /** Workspace-relative quiz-log path. */
  quizzes: string
}

/** Characters that cannot appear in a Windows path segment. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * Turn a human course name into one safe path segment. CJK and other
 * non-ASCII letters are preserved so `线性代数` keeps its name; only
 * separators, reserved characters, and whitespace runs are rewritten.
 *
 * @param raw The user-facing course name.
 * @returns A non-empty, filesystem-safe directory name.
 */
export function slugifyCourse(raw: string): string {
  const slug = raw
    .trim()
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  const clipped = slug.slice(0, 60).replace(/[.\-]+$/g, '')
  return clipped === '' ? 'course' : clipped
}

/** Join path segments with forward slashes, dropping empty ones. */
function join(...segments: readonly string[]): string {
  return segments
    .map(segment => segment.replace(/^\/+|\/+$/g, ''))
    .filter(segment => segment !== '')
    .join('/')
}

/**
 * Resolve the file layout of one course.
 *
 * @param notesDir Workspace-relative notes root from plugin config.
 * @param course User-facing course name.
 * @returns Every path the course tools write.
 */
export function courseLayout(notesDir: string, course: string): CourseLayout {
  const dir = join(notesDir, slugifyCourse(course))
  return {
    dir,
    syllabus: `${dir}/syllabus.md`,
    notes: `${dir}/notes.md`,
    quizzes: `${dir}/quizzes.md`,
  }
}

/** One module of a course syllabus. */
export interface SyllabusModule {
  /** Stable identifier the checkbox toggles, e.g. `m1` or `3`. */
  id: string
  /** Module title shown to the user. */
  title: string
  /** What the learner can do once the module is done. */
  objectives?: readonly string[]
  /** Whether the module was already completed when the syllabus was rewritten. */
  done?: boolean
}

/** Input of {@link renderSyllabus}. */
export interface SyllabusInput {
  course: string
  /** Why the learner is taking the course, and what "done" means. */
  goal?: string
  /** Declared starting level. */
  level?: string
  modules: readonly SyllabusModule[]
  /** Sources the course is built on. */
  sources?: readonly SourceRef[]
  /** Local date stamp `YYYY-MM-DD`. */
  date: string
}

/** A cited source. */
export interface SourceRef {
  title: string
  url?: string
}

/** Render one module checklist line. */
function moduleLine(module: SyllabusModule, done: boolean): string {
  const objectives = (module.objectives ?? []).map(objective => `   - ${objective}`).join('\n')
  const head = `- [${done ? 'x' : ' '}] ${module.id} · ${module.title}`
  return objectives === '' ? head : `${head}\n${objectives}`
}

/**
 * Render a course syllabus.
 *
 * @param input Course facts.
 * @returns Markdown for `syllabus.md`.
 */
export function renderSyllabus(input: SyllabusInput): string {
  const lines: string[] = [
    `# ${input.course}`,
    '',
    `> Maintained by dsh-edu-mode education mode · opened ${input.date}`,
    '',
    '## Goal',
    '',
    input.goal?.trim() ? input.goal.trim() : '_Not set yet._',
    '',
    '## Starting level',
    '',
    input.level?.trim() ? input.level.trim() : '_Unknown — ask once, then adapt._',
    '',
    '## Modules',
    '',
    ...(input.modules.length === 0
      ? ['_No modules yet._']
      : input.modules.map(module => moduleLine(module, false))),
    '',
  ]
  if ((input.sources ?? []).length > 0) {
    lines.push('## Sources', '', ...sourceLines(input.sources ?? []), '')
  }
  lines.push(
    '## Progress',
    '',
    'A module is checked off by `edu_course` action `complete` once its quizzes back the claim.',
    '',
  )
  return lines.join('\n')
}

/** Render source bullets. */
function sourceLines(sources: readonly SourceRef[]): string[] {
  return sources.map((source) => {
    const url = source.url?.trim()
    return url === undefined || url === '' ? `- ${source.title}` : `- [${source.title}](${url})`
  })
}

/** Input of {@link renderNoteSection}. */
export interface NoteInput {
  lesson: string
  /** The lesson body, in markdown. */
  body: string
  keyPoints?: readonly string[]
  misconceptions?: readonly string[]
  sources?: readonly SourceRef[]
  date: string
}

/**
 * Render one lesson section of the class notes.
 *
 * @param input Lesson facts.
 * @returns Markdown appended to `notes.md`.
 */
export function renderNoteSection(input: NoteInput): string {
  const lines: string[] = [`## ${input.lesson}`, '', `> ${input.date}`, '', input.body.trim(), '']
  const section = (title: string, items: readonly string[] | undefined): void => {
    if (items === undefined || items.length === 0) return
    lines.push(`### ${title}`, '', ...items.map(item => `- ${item}`), '')
  }
  section('Key points', input.keyPoints)
  section('Common misconceptions', input.misconceptions)
  if ((input.sources ?? []).length > 0) {
    lines.push('### Sources', '', ...sourceLines(input.sources ?? []), '')
  }
  return lines.join('\n')
}

/** One graded answer as recorded in the quiz log. */
export interface QuizLogEntry {
  question: string
  verdict: string
  /** What the learner answered, already formatted for reading. */
  responded: string
  /** The expected answer, when the quiz had one. */
  expected?: string
}

/** Input of {@link renderQuizSection}. */
export interface QuizLogInput {
  topic: string
  /** Fraction in `0..1`, or `undefined` when nothing could be auto-graded. */
  score: number | undefined
  correct: number
  gradable: number
  passed: boolean | undefined
  entries: readonly QuizLogEntry[]
  /** Learner-facing notes the model added, e.g. what to review next. */
  note?: string
  date: string
}

/** Render one quiz-log section. */
export function renderQuizSection(input: QuizLogInput): string {
  const percent = input.score === undefined ? 'n/a' : `${Math.round(input.score * 100)}%`
  const verdict = input.passed === undefined ? '' : input.passed ? ' · passed' : ' · needs review'
  const lines: string[] = [
    `## ${input.topic} — ${input.correct}/${input.gradable} (${percent})${verdict}`,
    '',
    `> ${input.date}`,
    '',
    ...input.entries.map((entry) => {
      const mark = entry.verdict === 'correct' ? '✅' : entry.verdict === 'partial' ? '🟡' : entry.verdict === 'skipped' ? '⏭️' : '❌'
      const head = `- ${mark} ${entry.question}`
      const answered = `  - answered: ${entry.responded}`
      const expected = entry.verdict === 'correct' || entry.expected === undefined
        ? []
        : [`  - expected: ${entry.expected}`]
      return [head, answered, ...expected].join('\n')
    }),
    '',
  ]
  if (input.note?.trim()) lines.push(`> ${input.note.trim()}`, '')
  return lines.join('\n')
}

/**
 * Check or uncheck one module in an existing syllabus. Only the checkbox of a
 * line whose identifier matches exactly is rewritten; everything else is
 * preserved byte for byte, so a hand-edited syllabus survives.
 *
 * @param markdown Current syllabus markdown.
 * @param moduleId The module identifier to toggle.
 * @param done Target checkbox state.
 * @returns The new markdown plus whether a matching line was found.
 */
export function toggleModule(
  markdown: string,
  moduleId: string,
  done: boolean,
): { text: string; changed: boolean } {
  const escaped = moduleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^- \\[[ xX]\\] ${escaped}(?=\\s|$)`, 'm')
  if (!pattern.test(markdown)) return { text: markdown, changed: false }
  const text = markdown.replace(pattern, `- [${done ? 'x' : ' '}] ${moduleId}`)
  return { text, changed: true }
}

/**
 * Read the module checklist out of a syllabus, so `status` can report progress
 * without a second bookkeeping file.
 *
 * @param markdown Current syllabus markdown.
 * @returns One entry per module line, in file order.
 */
export function parseModules(markdown: string): { id: string; title: string; done: boolean }[] {
  const modules: { id: string; title: string; done: boolean }[] = []
  for (const line of markdown.split('\n')) {
    const match = /^- \[([ xX])\] ([^·\s]+) · (.+?)\s*$/.exec(line)
    if (match === null) continue
    modules.push({ id: match[2], title: match[3], done: match[1].toLowerCase() === 'x' })
  }
  return modules
}

/** Outcome of {@link upsertSection}. */
export type SectionUpsert =
  | { kind: 'duplicate' }
  | { kind: 'written'; text: string; action: 'appended' | 'replaced' }

/**
 * Append a markdown section to a document, or replace the existing section with
 * the same `##` heading. A second write for the same lesson is reported as a
 * duplicate instead of silently stacking two copies of it.
 *
 * @param document Current document text (may be empty).
 * @param heading Section heading text, without the leading `## `.
 * @param section The rendered section, heading included.
 * @param replace Whether an existing same-heading section may be replaced.
 * @returns The new document, or a duplicate verdict.
 */
export function upsertSection(
  document: string,
  heading: string,
  section: string,
  replace: boolean,
): SectionUpsert {
  const lines = document.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === `## ${heading}`)
  if (start < 0) {
    const head = document.trim() === '' ? '' : `${document.replace(/\n+$/, '')}\n\n`
    return { kind: 'written', text: `${head}${section.replace(/\n+$/, '')}\n`, action: 'appended' }
  }
  if (!replace) return { kind: 'duplicate' }
  let end = start + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end++
  const merged = [...lines.slice(0, start), ...section.replace(/\n+$/, '').split('\n'), '', ...lines.slice(end)]
  return { kind: 'written', text: merged.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n'), action: 'replaced' }
}


/**
 * Local `YYYY-MM-DD` stamp for the given instant.
 *
 * @param now The instant to stamp.
 * @returns A date string in the machine's local time zone.
 */
export function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
