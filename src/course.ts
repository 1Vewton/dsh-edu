/**
 * `edu_course` and `edu_notes`: the durable half of education mode.
 *
 * `edu_course` owns the syllabus — the course identity, the module checklist,
 * and therefore progress across sessions. `edu_notes` owns the class notes:
 * one markdown section per lesson, written to be reread a month later.
 *
 * Both take their file access through a {@link NoteStore}, so all mutation
 * semantics (containment, atomic write, observation bookkeeping) live in one
 * place, and both refuse to guess: no course means an error telling the model to
 * open one, never a silently invented directory.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { NoteStore } from './store.ts'
import {
  courseLayout,
  parseModules,
  renderNoteSection,
  renderSyllabus,
  stamp,
  toggleModule,
  upsertSection,
} from './paths.ts'
import type { SourceRef } from './paths.ts'

/** Dependencies shared by the course tools. */
export interface CourseToolDeps {
  /** Course-file store. */
  store: NoteStore
  /** Notes root from plugin config. */
  notesDir: string
  /** The session's effective course name, or `undefined` when none is set. */
  activeCourse(agent: Agent | undefined): string | undefined
  /** Record the canonical course name in the mode state. */
  setCourse(agent: Agent | undefined, course: string): void
  /** Current instant, injected for testability. */
  now(): Date
}

/** One module as declared by the model. */
interface ModuleArg {
  id: string
  title: string
  objectives?: readonly string[]
}

/** Render a module identifier and title for humans. */
function label(module: { id: string; title: string }): string {
  return `${module.id} · ${module.title}`
}

/**
 * Register `edu_course` and `edu_notes`.
 *
 * @param ctx Plugin context holding `ctx.tools`.
 * @param deps Course dependencies.
 */
export function registerCourseTools(ctx: Context, deps: CourseToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'edu_course',
    description: 'Open, inspect, or advance the course the learner is studying in education mode. '
      + 'Action "open" writes or rewrites the syllabus (goal, level, module checklist, sources) and makes this the '
      + 'session\'s active course; open it before the first lesson. Action "status" reports progress and the next module. '
      + 'Action "complete" checks off one module once its quizzes back the claim. '
      + 'Course files live in the workspace under the configured notes directory.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'status', 'complete'], description: 'What to do with the course.' },
      course: { type: 'string', description: 'Course name, e.g. "线性代数". Required for open and complete; defaults to the active course for status.' },
      goal: { type: 'string', description: 'open: why the learner is studying this, and what "done" means.' },
      level: { type: 'string', description: 'open: declared starting level, e.g. "beginner", "已学过微积分".' },
      modules: {
        type: 'array',
        description: 'open: the module checklist, in teaching order. Omit to keep the modules already in the syllabus.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Short stable identifier, e.g. "m1" or "3".' },
            title: { type: 'string', required: true, description: 'Module title.' },
            objectives: { type: 'array', items: { type: 'string' }, description: 'What the learner can do once the module is done.' },
          },
        },
      },
      sources: {
        type: 'array',
        description: 'open: the sources the course is built on.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            url: { type: 'string' },
          },
        },
      },
      module: { type: 'string', description: 'complete: the identifier of the module to check off.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          course: { type: 'string', required: true },
          dir: { type: 'string', required: true },
          syllabus: { type: 'string', required: true },
          notes: { type: 'string', required: true },
          quizzes: { type: 'string', required: true },
          modules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                done: { type: 'boolean', required: true },
              },
            },
          },
          nextModule: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: async (args, exec) => {
      const today = stamp(deps.now())
      const requested = args.course?.trim()
      const course = args.action === 'status'
        ? requested !== undefined && requested !== '' ? requested : deps.activeCourse(exec.agent)
        : requested
      if (course === undefined || course === '') {
        throw new Error(args.action === 'status'
          ? 'edu_course needs a course: no active course is set, so pass `course`'
          : `edu_course action "${args.action}" needs a course name`)
      }
      const layout = courseLayout(deps.notesDir, course)

      if (args.action === 'open') {
        // Rewriting a syllabus must not lose progress: a module keeps its
        // checked state when its identifier survives the rewrite.
        const existing = await deps.store.read(layout.syllabus, exec)
        const done = new Map(parseModules(existing ?? '').map(module => [module.id, module.done]))
        const declared: ModuleArg[] = args.modules === undefined || args.modules.length === 0
          ? parseModules(existing ?? '').map(module => ({ id: module.id, title: module.title }))
          : args.modules.map(module => ({
            id: module.id.trim(),
            title: module.title.trim(),
            ...module.objectives === undefined ? {} : { objectives: module.objectives },
          }))
        for (const module of declared) {
          if (module.id === '') throw new Error('edu_course: every module needs a non-empty id')
          if (module.title === '') throw new Error(`edu_course: module "${module.id}" needs a non-empty title`)
        }
        const ids = new Set(declared.map(module => module.id))
        if (ids.size !== declared.length) throw new Error('edu_course: module ids must be unique')
        const sources: SourceRef[] = (args.sources ?? []).map(source => ({
          title: source.title,
          ...source.url === undefined ? {} : { url: source.url },
        }))
        const markdown = renderSyllabus({
          course,
          ...args.goal === undefined ? {} : { goal: args.goal },
          ...args.level === undefined ? {} : { level: args.level },
          modules: declared.map(module => ({ ...module, done: done.get(module.id) === true })),
          ...sources.length === 0 ? {} : { sources },
          date: today,
        })
        const file = await deps.store.write(layout.syllabus, markdown, exec)
        deps.setCourse(exec.agent, course)
        const next = declared.find(module => done.get(module.id) !== true)
        const summary = `Course "${course}" opened (${file.operation === 'create' ? 'new syllabus' : 'syllabus updated'}). `
          + `${declared.length} module(s): ${layout.syllabus}. `
          + (next === undefined
            ? 'Every module is already checked off.'
            : `Next module: ${label(next)} — teach it, write the notes with edu_notes, then quiz it with edu_quiz.`)
        return {
          action: 'open' as const,
          course,
          dir: layout.dir,
          syllabus: layout.syllabus,
          notes: layout.notes,
          quizzes: layout.quizzes,
          modules: declared.map(module => ({ id: module.id, title: module.title, done: done.get(module.id) === true })),
          nextModule: next === undefined ? null : { id: next.id, title: next.title },
          summary,
        }
      }

      const syllabus = await deps.store.read(layout.syllabus, exec)
      if (syllabus === undefined) {
        throw new Error(`no syllabus at ${layout.syllabus}: call edu_course action "open" with a goal and modules first`)
      }
      const modules = parseModules(syllabus)

      if (args.action === 'status') {
        const next = modules.find(module => !module.done)
        const doneCount = modules.filter(module => module.done).length
        const summary = `Course "${course}": ${doneCount}/${modules.length} module(s) done.`
          + (next === undefined ? ' The course is complete.' : ` Next: ${label(next)}.`)
          + ` Notes: ${layout.notes} · quizzes: ${layout.quizzes}`
        return {
          action: 'status' as const,
          course,
          dir: layout.dir,
          syllabus: layout.syllabus,
          notes: layout.notes,
          quizzes: layout.quizzes,
          modules,
          nextModule: next === undefined ? null : { id: next.id, title: next.title },
          summary,
        }
      }

      const moduleId = args.module?.trim() ?? ''
      if (moduleId === '') throw new Error('edu_course action "complete" needs the module identifier in `module`')
      const toggled = toggleModule(syllabus, moduleId, true)
      if (!toggled.changed) {
        throw new Error(`unknown module "${moduleId}" in ${layout.syllabus}; known ids: ${modules.map(module => module.id).join(', ') || '(none)'}`)
      }
      await deps.store.write(layout.syllabus, toggled.text, exec)
      const updated = parseModules(toggled.text)
      const next = updated.find(module => !module.done)
      const doneCount = updated.filter(module => module.done).length
      return {
        action: 'complete' as const,
        course,
        dir: layout.dir,
        syllabus: layout.syllabus,
        notes: layout.notes,
        quizzes: layout.quizzes,
        modules: updated,
        nextModule: next === undefined ? null : { id: next.id, title: next.title },
        summary: `Module "${moduleId}" marked done (${doneCount}/${updated.length}). `
          + (next === undefined ? 'The course is complete.' : `Next: ${label(next)} — propose it and wait for the learner to confirm.`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edu_notes',
    description: 'Write the class notes for one lesson into the active course, as a markdown section in the course notes file. '
      + 'Call it once per lesson, after explaining and before quizzing, with the explanation, the key points, the mistakes to '
      + 'avoid, and the sources you relied on. It writes notes a month-later revision can use, not a chat transcript.',
    parameters: {
      lesson: { type: 'string', required: true, description: 'Lesson title, e.g. "第 3 讲 · 特征值与特征向量".' },
      markdown: { type: 'string', required: true, description: 'The lesson body in markdown: definitions, derivation, worked example.' },
      course: { type: 'string', description: 'Course name. Defaults to the active course of education mode.' },
      keyPoints: { type: 'array', items: { type: 'string' }, description: 'The handful of things to remember.' },
      misconceptions: { type: 'array', items: { type: 'string' }, description: 'Common mistakes and why they happen.' },
      sources: {
        type: 'array',
        description: 'Sources this lesson relied on.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string', required: true }, url: { type: 'string' } },
        },
      },
      replace: { type: 'boolean', description: 'Rewrite the section when this lesson already has one (default false, which reports a duplicate instead).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          course: { type: 'string', required: true },
          lesson: { type: 'string', required: true },
          path: { type: 'string', required: true },
          action: { type: 'string', required: true, enum: ['appended', 'replaced'] },
          characters: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute: async (args, exec) => {
      const course = args.course?.trim() || deps.activeCourse(exec.agent)
      if (course === undefined || course === '') {
        throw new Error('edu_notes needs a course: pass `course`, open one with edu_course, or switch the session into education mode')
      }
      const lesson = args.lesson.trim()
      if (lesson === '') throw new Error('edu_notes needs a non-empty lesson title')
      if (args.markdown.trim() === '') throw new Error('edu_notes needs the lesson body in `markdown`')
      const layout = courseLayout(deps.notesDir, course)
      const section = renderNoteSection({
        lesson,
        body: args.markdown,
        ...args.keyPoints === undefined ? {} : { keyPoints: args.keyPoints },
        ...args.misconceptions === undefined ? {} : { misconceptions: args.misconceptions },
        ...args.sources === undefined ? {} : { sources: args.sources },
        date: stamp(deps.now()),
      })
      const existing = await deps.store.read(layout.notes, exec)
      const upsert = upsertSection(existing ?? '', lesson, section, args.replace === true)
      if (upsert.kind === 'duplicate') {
        throw new Error(`notes for lesson "${lesson}" already exist in ${layout.notes}; pass replace: true to rewrite that section`)
      }
      // A new notes file gets its title, so the document reads as a course log
      // rather than as an orphan section.
      const document = existing === undefined
        ? `# ${course} · class notes\n\nMaintained by dsh-edu-mode education mode, one section per lesson.\n\n${upsert.text}`
        : upsert.text
      const file = await deps.store.write(layout.notes, document, exec)
      return {
        course,
        lesson,
        path: file.path,
        action: upsert.action,
        characters: upsert.text.length,
        summary: `Class notes for "${lesson}" ${upsert.action === 'appended' ? 'added to' : 'rewritten in'} ${file.path}. `
          + 'Now quiz the learner on this lesson with edu_quiz before moving on.',
      }
    },
  }))
}
