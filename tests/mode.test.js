import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { foldEduMode, resolveConfig } from '../lib/index.js'
import { renderDefaultPolicy } from '../lib/policy.js'

/** A log holding only the events a mode fold cares about. */
const log = (...states) => states.map(state => ({ type: 'edu/mode', data: state }))

describe('resolveConfig', () => {
  it('applies defaults', () => {
    assert.deepEqual(resolveConfig(), { notesDir: 'edu-notes', maxQuizQuestions: 6, passRatio: 0.8 })
  })

  it('rejects unknown keys and unusable values at load', () => {
    assert.throws(() => resolveConfig({ notesdir: 'x' }), /unknown key/)
    assert.throws(() => resolveConfig({ notesDir: '  ' }), /non-empty `notesDir`/)
    assert.throws(() => resolveConfig({ notesDir: '../outside' }), /workspace-relative/)
    assert.throws(() => resolveConfig({ notesDir: 'C:/tmp' }), /workspace-relative/)
    assert.throws(() => resolveConfig({ maxQuizQuestions: 0 }), /maxQuizQuestions/)
    assert.throws(() => resolveConfig({ maxQuizQuestions: 2.5 }), /maxQuizQuestions/)
    assert.throws(() => resolveConfig({ passRatio: 0 }), /passRatio/)
    assert.throws(() => resolveConfig({ passRatio: 1.5 }), /passRatio/)
    assert.throws(() => resolveConfig({ policy: '  ' }), /`policy` must be non-empty/)
  })

  it('keeps a deployment policy and normalizes the notes root', () => {
    assert.equal(resolveConfig({ policy: 'teach well' }).policy, 'teach well')
    assert.equal(resolveConfig({ notesDir: 'notes/edu/' }).notesDir, 'notes/edu')
  })
})

describe('foldEduMode', () => {
  it('folds an empty log to inactive', () => {
    assert.deepEqual(foldEduMode([]), { active: false })
  })

  it('lets the last event win, including the course', () => {
    assert.deepEqual(foldEduMode(log({ active: true, course: '拓扑学' })), { active: true, course: '拓扑学' })
    assert.deepEqual(
      foldEduMode(log({ active: true, course: '拓扑学' }, { active: true, course: '线性代数' })),
      { active: true, course: '线性代数' },
    )
    assert.deepEqual(foldEduMode(log({ active: true, course: '拓扑学' }, { active: false })), { active: false })
  })

  it('honours the end bound, so a mid-log switch can be read', () => {
    const events = log({ active: true, course: 'a' }, { active: false })
    assert.deepEqual(foldEduMode(events, 1), { active: true, course: 'a' })
  })
})

describe('renderDefaultPolicy', () => {
  it('fills the notes directory and a quiz-size hint', () => {
    const policy = renderDefaultPolicy({ notesDir: 'edu-notes', maxQuizQuestions: 6 })
    assert.match(policy, /`edu-notes\/<course>\/`/)
    assert.doesNotMatch(policy, /\{\{/)
    assert.match(policy, /4–6 questions/)
    assert.match(policy, /edu_quiz/)
    assert.match(policy, /edu_notes/)
    assert.match(policy, /edu_course/)
  })
})
