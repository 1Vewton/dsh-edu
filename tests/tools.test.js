/**
 * The three course tools, driven through the definitions the plugin registers:
 * `edu_course` (syllabus and progress), `edu_notes` (class notes) and
 * `edu_quiz` (ask, grade, log).
 *
 * The tools are executed directly with a fake execution context, so what is
 * under test is the plugin's own behaviour: argument handling, file layout,
 * grading, the quiz log, and every degradation path when the question channel
 * cannot answer.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { registerCourseTools } from '../lib/course.js'
import { registerQuizTool } from '../lib/quiz.js'
import { createNoteStore } from '../lib/store.js'
import {
  fakeAgent,
  fakeContext,
  fakeExec,
  fakeFs,
  fakeSession,
  fakeUserQuestions,
  readWorkspaceFile,
  scratchWorkspace,
  workspaceFileExists,
} from './helpers.mjs'

const NOW = new Date(2026, 1, 14, 10, 0, 0)

/** Wire the plugin's tools exactly as the plugin does, over a scratch workspace. */
async function bench({ userQuestions, maxQuestions = 6, passRatio = 0.8 } = {}) {
  const ws = await scratchWorkspace('tools')
  const fs = fakeFs()
  const ctx = fakeContext({ fs, userQuestions })
  const session = fakeSession({ cwd: ws.dir })
  const agent = fakeAgent(session)
  const exec = fakeExec(agent)
  const store = createNoteStore(ctx)
  const opened = []
  let active
  const deps = {
    store,
    notesDir: 'edu-notes',
    activeCourse: () => active,
    setCourse: (_agent, course) => { active = course; opened.push(course) },
    now: () => NOW,
  }
  registerCourseTools(ctx, deps)
  registerQuizTool(ctx, { ...deps, maxQuestions, passRatio, store: () => store })
  const tool = name => {
    const definition = ctx.toolsList.find(candidate => candidate.name === name)
    assert.ok(definition, `tool ${name} was registered`)
    return definition
  }
  return { ws, ctx, exec, store, opened, tool, userQuestions, setActive: course => { active = course }, getActive: () => active }
}

describe('edu_course', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.ws.dispose())

  it('opens a course: writes the syllabus and makes it the active course', async () => {
    const value = await b.tool('edu_course').execute({
      action: 'open',
      course: 'Linear Algebra',
      goal: 'Understand matrix derivations',
      level: 'knows calculus',
      modules: [
        { id: 'm1', title: 'Determinants', objectives: ['compute a 3x3 by hand'] },
        { id: 'm2', title: 'Eigenvalues' },
      ],
      sources: [{ title: 'MIT 18.06', url: 'https://ocw.mit.edu/18-06' }],
    }, b.exec)

    assert.equal(value.action, 'open')
    assert.equal(value.course, 'Linear Algebra')
    assert.equal(value.dir, 'edu-notes/Linear-Algebra')
    assert.equal(value.syllabus, 'edu-notes/Linear-Algebra/syllabus.md')
    assert.equal(value.notes, 'edu-notes/Linear-Algebra/notes.md')
    assert.equal(value.quizzes, 'edu-notes/Linear-Algebra/quizzes.md')
    assert.deepEqual(value.modules, [
      { id: 'm1', title: 'Determinants', done: false },
      { id: 'm2', title: 'Eigenvalues', done: false },
    ])
    assert.deepEqual(value.nextModule, { id: 'm1', title: 'Determinants' })
    assert.match(value.summary, /Course "Linear Algebra" opened/)
    assert.deepEqual(b.opened, ['Linear Algebra'])

    const syllabus = await readWorkspaceFile(b.ws.dir, 'edu-notes/Linear-Algebra/syllabus.md')
    assert.match(syllabus, /^# Linear Algebra$/m)
    assert.match(syllabus, /Understand matrix derivations/)
    assert.match(syllabus, /knows calculus/)
    assert.match(syllabus, /- \[ \] m1 · Determinants\n {3}- compute a 3x3 by hand/)
    assert.match(syllabus, /\[MIT 18\.06\]\(https:\/\/ocw\.mit\.edu\/18-06\)/)
    assert.match(syllabus, /opened 2026-02-14/)
  })

  it('keeps CJK course names as directory names', async () => {
    const value = await b.tool('edu_course').execute({
      action: 'open',
      course: '线性代数',
      modules: [{ id: '1', title: '行列式' }],
    }, b.exec)
    assert.equal(value.syllabus, 'edu-notes/线性代数/syllabus.md')
    assert.equal(await workspaceFileExists(b.ws.dir, 'edu-notes/线性代数/syllabus.md'), true)
  })

  it('reports progress and the next module', async () => {
    const value = await b.tool('edu_course').execute({ action: 'status', course: 'Linear Algebra' }, b.exec)
    assert.equal(value.summary, 'Course "Linear Algebra": 0/2 module(s) done. Next: m1 · Determinants. '
      + 'Notes: edu-notes/Linear-Algebra/notes.md · quizzes: edu-notes/Linear-Algebra/quizzes.md')
    assert.deepEqual(value.nextModule, { id: 'm1', title: 'Determinants' })
  })

  it('checks a module off and advances', async () => {
    const value = await b.tool('edu_course').execute({ action: 'complete', course: 'Linear Algebra', module: 'm1' }, b.exec)
    assert.equal(value.summary, 'Module "m1" marked done (1/2). Next: m2 · Eigenvalues — propose it and wait for the learner to confirm.')
    const syllabus = await readWorkspaceFile(b.ws.dir, 'edu-notes/Linear-Algebra/syllabus.md')
    assert.match(syllabus, /- \[x\] m1 · Determinants/)
    assert.match(syllabus, /- \[ \] m2 · Eigenvalues/)
  })

  it('preserves checked modules when the syllabus is rewritten', async () => {
    const value = await b.tool('edu_course').execute({
      action: 'open',
      course: 'Linear Algebra',
      goal: 'Revised goal',
      modules: [{ id: 'm1', title: 'Determinants' }, { id: 'm3', title: 'Diagonalisation' }],
    }, b.exec)
    assert.deepEqual(value.modules, [
      { id: 'm1', title: 'Determinants', done: true },
      { id: 'm3', title: 'Diagonalisation', done: false },
    ])
    const syllabus = await readWorkspaceFile(b.ws.dir, 'edu-notes/Linear-Algebra/syllabus.md')
    assert.match(syllabus, /Revised goal/)
    assert.match(syllabus, /- \[x\] m1 · Determinants/)
    assert.doesNotMatch(syllabus, /Eigenvalues/)
  })

  it('keeps the existing modules when a rewrite declares none', async () => {
    const value = await b.tool('edu_course').execute({ action: 'open', course: 'Linear Algebra' }, b.exec)
    assert.deepEqual(value.modules.map(module => module.id), ['m1', 'm3'])
  })

  it('refuses unknown modules and reports the known ids', async () => {
    await assert.rejects(
      b.tool('edu_course').execute({ action: 'complete', course: 'Linear Algebra', module: 'nope' }, b.exec),
      /unknown module "nope".*known ids: m1, m3/,
    )
  })

  it('refuses to report on a course that was never opened', async () => {
    await assert.rejects(
      b.tool('edu_course').execute({ action: 'status', course: 'Nothing Here' }, b.exec),
      /no syllabus at edu-notes\/Nothing-Here\/syllabus\.md.*action "open"/,
    )
  })

  it('requires a course, and a module for complete', async () => {
    const previous = b.getActive()
    b.setActive(undefined)
    try {
      await assert.rejects(b.tool('edu_course').execute({ action: 'status' }, b.exec), /no active course is set/)
      await assert.rejects(b.tool('edu_course').execute({ action: 'open' }, b.exec), /needs a course name/)
      await assert.rejects(
        b.tool('edu_course').execute({ action: 'complete', course: 'Linear Algebra' }, b.exec),
        /needs the module identifier/,
      )
    } finally {
      b.setActive(previous)
    }
  })

  it('validates the module list', async () => {
    await assert.rejects(
      b.tool('edu_course').execute({ action: 'open', course: 'Bad', modules: [{ id: ' ', title: 'x' }] }, b.exec),
      /non-empty id/,
    )
    await assert.rejects(
      b.tool('edu_course').execute({ action: 'open', course: 'Bad', modules: [{ id: 'a', title: ' ' }] }, b.exec),
      /non-empty title/,
    )
    await assert.rejects(
      b.tool('edu_course').execute({
        action: 'open',
        course: 'Bad',
        modules: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }],
      }, b.exec),
      /ids must be unique/,
    )
  })
})

describe('edu_notes', () => {
  let b
  before(async () => {
    b = await bench()
    await b.tool('edu_course').execute({
      action: 'open',
      course: 'Topology',
      modules: [{ id: 'm1', title: 'Open sets' }],
    }, b.exec)
  })
  after(() => b.ws.dispose())

  it('writes one class-notes section per lesson', async () => {
    const value = await b.tool('edu_notes').execute({
      lesson: 'L1 · Open sets',
      markdown: 'A topology is a set with a family of open subsets.',
      keyPoints: ['open sets are closed under finite intersections'],
      misconceptions: ['open does not mean bounded'],
      sources: [{ title: 'Munkres', url: 'https://example.org/munkres' }],
    }, b.exec)

    assert.equal(value.action, 'appended')
    assert.equal(value.path, 'edu-notes/Topology/notes.md')
    assert.equal(value.course, 'Topology')
    const notes = await readWorkspaceFile(b.ws.dir, 'edu-notes/Topology/notes.md')
    assert.match(notes, /^# Topology · class notes$/m)
    assert.match(notes, /Maintained by dsh-edu-mode education mode/)
    assert.match(notes, /## L1 · Open sets\n\n> 2026-02-14\n\nA topology is a set/)
    assert.match(notes, /### Key points\n\n- open sets are closed under finite intersections/)
    assert.match(notes, /### Common misconceptions\n\n- open does not mean bounded/)
    assert.match(notes, /### Sources\n\n- \[Munkres\]\(https:\/\/example\.org\/munkres\)/)
    assert.match(value.summary, /Now quiz the learner/)
  })

  it('refuses a silent duplicate and rewrites with replace', async () => {
    const args = { lesson: 'L1 · Open sets', markdown: 'Rewritten body.' }
    await assert.rejects(b.tool('edu_notes').execute(args, b.exec), /already exist.*replace: true/)
    const value = await b.tool('edu_notes').execute({ ...args, replace: true }, b.exec)
    assert.equal(value.action, 'replaced')
    const notes = await readWorkspaceFile(b.ws.dir, 'edu-notes/Topology/notes.md')
    assert.match(notes, /Rewritten body\./)
    assert.doesNotMatch(notes, /A topology is a set/)
    assert.equal(notes.match(/## L1 · Open sets/g).length, 1)
  })

  it('appends a second lesson without touching the first', async () => {
    await b.tool('edu_notes').execute({ lesson: 'L2 · Continuity', markdown: 'Preimages of open sets.' }, b.exec)
    const notes = await readWorkspaceFile(b.ws.dir, 'edu-notes/Topology/notes.md')
    assert.equal(notes.match(/^## /gm).length, 2)
    assert.match(notes, /## L1 · Open sets/)
    assert.match(notes, /## L2 · Continuity/)
  })

  it('uses the active course and validates its arguments', async () => {
    const value = await b.tool('edu_notes').execute({ lesson: 'L3', markdown: 'body' }, b.exec)
    assert.equal(value.course, 'Topology')
    b.setActive(undefined)
    await assert.rejects(b.tool('edu_notes').execute({ lesson: 'L4', markdown: 'body' }, b.exec), /needs a course/)
    b.setActive('Topology')
    await assert.rejects(b.tool('edu_notes').execute({ lesson: '  ', markdown: 'body' }, b.exec), /non-empty lesson title/)
    await assert.rejects(b.tool('edu_notes').execute({ lesson: 'L5', markdown: '   ' }, b.exec), /needs the lesson body/)
  })
})

describe('edu_quiz', () => {
  const question = {
    question: 'Is a circular orbit a special case of an ellipse?',
    options: ['yes', 'no'],
    answer: ['yes'],
    explanation: 'A circle is an ellipse with zero eccentricity.',
  }

  it('asks, grades, logs, and reports the score', async () => {
    const channel = fakeUserQuestions({ answers: [{ id: 'q1', selected: ['yes'] }] })
    const b = await bench({ userQuestions: channel })
    try {
      await b.tool('edu_course').execute({ action: 'open', course: 'Orbits', modules: [{ id: 'm1', title: 'Kepler' }] }, b.exec)
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec)

      assert.equal(channel.requests.length, 1)
      assert.equal(channel.requests[0].questions[0].id, 'q1')
      assert.deepEqual(channel.requests[0].questions[0].options, [{ label: 'yes' }, { label: 'no' }])
      assert.equal(channel.requests[0].questions[0].question, question.question)
      assert.equal(value.status, 'graded')
      assert.equal(value.course, 'Orbits')
      assert.equal(value.correct, 1)
      assert.equal(value.gradable, 1)
      assert.equal(value.score, 1)
      assert.equal(value.passed, true)
      assert.deepEqual(value.weakPoints, [])
      assert.equal(value.logPath, 'edu-notes/Orbits/quizzes.md')
      assert.match(value.guidance, /propose the next topic or module/)

      const log = await readWorkspaceFile(b.ws.dir, 'edu-notes/Orbits/quizzes.md')
      assert.match(log, /^# Orbits · quizzes/m)
      assert.match(log, /## orbits — 1\/1 \(100%\) · passed/)
      assert.match(log, /- ✅ Is a circular orbit a special case of an ellipse\?/)
    } finally {
      await b.ws.dispose()
    }
  })

  it('records the expected answer and the weak point when the learner is wrong', async () => {
    const channel = fakeUserQuestions({ answers: [{ id: 'q1', selected: ['no'] }] })
    const b = await bench({ userQuestions: channel })
    try {
      await b.tool('edu_course').execute({ action: 'open', course: 'Orbits', modules: [{ id: 'm1', title: 'Kepler' }] }, b.exec)
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question], note: 'review eccentricity' }, b.exec)

      assert.equal(value.correct, 0)
      assert.equal(value.incorrect, 1)
      assert.equal(value.passed, false)
      assert.deepEqual(value.weakPoints, [question.question])
      assert.match(value.guidance, /Re-teach the weak points/)
      const log = await readWorkspaceFile(b.ws.dir, 'edu-notes/Orbits/quizzes.md')
      assert.match(log, /- ❌ Is a circular orbit.*\n {2}- answered: no\n {2}- expected: yes/)
      assert.match(log, /> review eccentricity/)
    } finally {
      await b.ws.dispose()
    }
  })

  it('leaves open questions to the model and keeps them out of the score', async () => {
    const channel = fakeUserQuestions({
      answers: [
        { id: 'q1', selected: ['yes'] },
        { id: 'q2', selected: [], custom: 'a circle has zero eccentricity' },
      ],
    })
    const b = await bench({ userQuestions: channel })
    try {
      b.setActive('Orbits')
      const value = await b.tool('edu_quiz').execute({
        topic: 'orbits',
        questions: [question, { question: 'Why?', answer: ['reference'] }],
      }, b.exec)
      assert.equal(value.gradable, 1)
      assert.equal(value.needsReview, 1)
      assert.equal(value.score, 1)
      assert.deepEqual(value.results[1].verdict, 'needs_review')
      assert.equal(value.results[1].custom, 'a circle has zero eccentricity')
      assert.deepEqual(value.weakPoints, ['Why?'])
    } finally {
      await b.ws.dispose()
    }
  })

  it('gives half credit for a partial multi-select answer', async () => {
    const channel = fakeUserQuestions({ answers: [{ id: 'q1', selected: ['a'] }] })
    const b = await bench({ userQuestions: channel, passRatio: 0.8 })
    try {
      b.setActive('Sets')
      const value = await b.tool('edu_quiz').execute({
        topic: 'sets',
        questions: [{ question: 'pick two', options: ['a', 'b', 'c'], answer: ['a', 'b'], multiSelect: true }],
      }, b.exec)
      assert.equal(value.partial, 1)
      assert.equal(value.score, 0.5)
      assert.equal(value.passed, false)
    } finally {
      await b.ws.dispose()
    }
  })

  it('honours a per-call pass ratio', async () => {
    const channel = fakeUserQuestions({ answers: [{ id: 'q1', selected: ['no'] }] })
    const b = await bench({ userQuestions: channel })
    try {
      b.setActive('Orbits')
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question, { ...question, question: 'again' }], passRatio: 0.4 }, b.exec)
      assert.equal(value.score, 0)
      assert.equal(value.passed, false)
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question], passRatio: 2 }, b.exec),
        /fraction greater than 0 and at most 1/,
      )
    } finally {
      await b.ws.dispose()
    }
  })

  it('hands the questions back when no question channel is composed', async () => {
    const b = await bench()
    try {
      b.setActive('Orbits')
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec)
      assert.equal(value.status, 'no_channel')
      assert.equal(value.needsReview, 1)
      assert.equal(value.score, null)
      assert.equal(value.results[0].verdict, 'skipped')
      assert.deepEqual(value.results[0].expected, ['yes'])
      assert.equal(value.logPath, undefined)
      assert.equal(await workspaceFileExists(b.ws.dir, 'edu-notes/Orbits/quizzes.md'), false)
      const text = b.tool('edu_quiz').output.render({ topic: 'orbits', questions: [question] }, value)[0].text
      assert.match(text, /No interactive question channel is available/)
    } finally {
      await b.ws.dispose()
    }
  })

  it('degrades the same way when the channel has no provider', async () => {
    const error = Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' })
    const b = await bench({ userQuestions: fakeUserQuestions({ error }) })
    try {
      b.setActive('Orbits')
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec)
      assert.equal(value.status, 'no_channel')
    } finally {
      await b.ws.dispose()
    }
  })

  it('reports a dismissed quiz as such instead of failing', async () => {
    const error = Object.assign(new Error('cancelled'), { code: 'ASK_CANCELLED' })
    const b = await bench({ userQuestions: fakeUserQuestions({ error }) })
    try {
      b.setActive('Orbits')
      const value = await b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec)
      assert.equal(value.status, 'dismissed')
      const text = b.tool('edu_quiz').output.render({ topic: 'orbits', questions: [question] }, value)[0].text
      assert.match(text, /dismissed the "orbits" quiz/)
    } finally {
      await b.ws.dispose()
    }
  })

  it('propagates a real failure and validates its arguments', async () => {
    const error = Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })
    const b = await bench({ userQuestions: fakeUserQuestions({ error }), maxQuestions: 2 })
    try {
      b.setActive('Orbits')
      await assert.rejects(b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec), /aborted/)
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question, question, question] }, b.exec),
        /at most 2 questions/,
      )
      await assert.rejects(b.tool('edu_quiz').execute({ topic: 'orbits', questions: [] }, b.exec), /at least one question/)
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [{ question: 'q', options: ['a'], answer: ['b'] }] }, b.exec),
        /"b" is not one of the options/,
      )
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [{ question: 'q', answer: ['a'], multiSelect: true }] }, b.exec),
        /multiSelect requires options/,
      )
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [{ question: 'q', answer: [] }] }, b.exec),
        /at least one acceptable answer/,
      )
      await assert.rejects(
        b.tool('edu_quiz').execute({ topic: 'orbits', questions: [{ question: '  ', answer: ['a'] }] }, b.exec),
        /non-empty text/,
      )
    } finally {
      await b.ws.dispose()
    }
  })

  it('needs a course before it can log anything', async () => {
    const b = await bench()
    try {
      await assert.rejects(b.tool('edu_quiz').execute({ topic: 'orbits', questions: [question] }, b.exec), /needs a course/)
    } finally {
      await b.ws.dispose()
    }
  })

  it('renders the graded report the model reads', async () => {
    const channel = fakeUserQuestions({ answers: [{ id: 'q1', selected: ['no'] }] })
    const b = await bench({ userQuestions: channel })
    try {
      b.setActive('Orbits')
      const args = { topic: 'orbits', questions: [question] }
      const value = await b.tool('edu_quiz').execute(args, b.exec)
      const text = b.tool('edu_quiz').output.render(args, value)[0].text
      assert.match(text, /Quiz "orbits": 0\/1 correct \(0%\) — needs review/)
      assert.match(text, /- \[incorrect\] Is a circular orbit/)
      assert.match(text, /expected: yes/)
      assert.match(text, /explanation: A circle is an ellipse with zero eccentricity\./)
      assert.match(text, /Quiz log: edu-notes\/Orbits\/quizzes\.md/)
    } finally {
      await b.ws.dispose()
    }
  })
})
