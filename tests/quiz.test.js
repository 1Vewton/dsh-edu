import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { gradeQuiz, renderQuizResult } from '../lib/quiz.js'

const single = (answer, extra = {}) => ({
  id: 'q1',
  question: 'which one?',
  options: ['A', 'B', 'C'],
  answer: [answer],
  ...extra,
})

describe('gradeQuiz — single select', () => {
  it('accepts any declared acceptable label', () => {
    const result = gradeQuiz([single('A', { answer: ['A', 'a-ish'] })], [{ id: 'q1', selected: ['a-ish'] }], 0.8)
    assert.equal(result.outcomes[0].verdict, 'correct')
    assert.equal(result.score, 1)
    assert.equal(result.passed, true)
  })

  it('ignores case, padding and trailing punctuation', () => {
    const result = gradeQuiz([single('A')], [{ id: 'q1', selected: ['  a. '] }], 0.8)
    assert.equal(result.outcomes[0].verdict, 'correct')
  })

  it('grades a typed answer that overrides the selection', () => {
    const typed = gradeQuiz([single('A')], [{ id: 'q1', selected: ['B'], custom: 'A' }], 0.8)
    assert.equal(typed.outcomes[0].verdict, 'correct')
    assert.equal(typed.outcomes[0].responded, 'A')
    const wrong = gradeQuiz([single('A')], [{ id: 'q1', selected: ['A'], custom: 'B' }], 0.8)
    assert.equal(wrong.outcomes[0].verdict, 'incorrect')
  })

  it('marks an unanswered question skipped and still counts it', () => {
    const result = gradeQuiz([single('A')], [{ id: 'q1', selected: [] }], 0.8)
    assert.equal(result.outcomes[0].verdict, 'skipped')
    assert.equal(result.gradable, 1)
    assert.equal(result.score, 0)
    assert.equal(result.passed, false)
  })
})

describe('gradeQuiz — multi select', () => {
  const multi = {
    id: 'q1',
    question: 'pick two',
    options: ['A', 'B', 'C'],
    answer: ['A', 'C'],
    multiSelect: true,
  }

  it('needs exactly the declared set', () => {
    const exact = gradeQuiz([multi], [{ id: 'q1', selected: ['C', 'A'] }], 0.8)
    assert.equal(exact.outcomes[0].verdict, 'correct')
  })

  it('gives half credit for a non-empty proper subset', () => {
    const partial = gradeQuiz([multi], [{ id: 'q1', selected: ['A'] }], 0.8)
    assert.equal(partial.outcomes[0].verdict, 'partial')
    assert.equal(partial.score, 0.5)
  })

  it('is incorrect when a wrong label joins the set', () => {
    const wrong = gradeQuiz([multi], [{ id: 'q1', selected: ['A', 'B', 'C'] }], 0.8)
    assert.equal(wrong.outcomes[0].verdict, 'incorrect')
  })

  it('defers free text to the model', () => {
    const free = gradeQuiz([multi], [{ id: 'q1', selected: [], custom: 'A and C because…' }], 0.8)
    assert.equal(free.outcomes[0].verdict, 'needs_review')
    assert.equal(free.gradable, 0)
    assert.equal(free.score, undefined)
    assert.equal(free.passed, undefined)
  })
})

describe('gradeQuiz — open questions and scoring', () => {
  const open = { id: 'q1', question: 'explain it', answer: ['reference answer'] }

  it('never auto-grades an open question', () => {
    const result = gradeQuiz([open], [{ id: 'q1', selected: [], custom: 'my explanation' }], 0.8)
    assert.equal(result.outcomes[0].verdict, 'needs_review')
    assert.equal(result.needsReview, 1)
    assert.equal(result.score, undefined)
  })

  it('scores over gradable questions only and reports weak points', () => {
    const questions = [
      single('A'),
      { ...single('B'), id: 'q2', question: 'second' },
      { ...open, id: 'q3' },
    ]
    const result = gradeQuiz(questions, [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['C'] },
      { id: 'q3', selected: [], custom: 'prose' },
    ], 0.8)
    assert.equal(result.gradable, 2)
    assert.equal(result.correct, 1)
    assert.equal(result.incorrect, 1)
    assert.equal(result.needsReview, 1)
    assert.equal(result.score, 0.5)
    assert.equal(result.passed, false)
    assert.deepEqual(result.weakPoints, ['second', 'explain it'])
  })

  it('honours the pass ratio it is given', () => {
    const questions = [single('A'), { ...single('B'), id: 'q2' }]
    const answers = [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['wrong'] }]
    assert.equal(gradeQuiz(questions, answers, 0.5).passed, true)
    assert.equal(gradeQuiz(questions, answers, 0.8).passed, false)
  })
})

describe('renderQuizResult', () => {
  it('states the score, the verdicts and the next move', () => {
    const result = gradeQuiz(
      [single('A'), { ...single('B'), id: 'q2', question: 'second', explanation: 'because B' }],
      [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['C'] }],
      0.8,
    )
    const text = renderQuizResult('行列式', result, 'edu-notes/线性代数/quizzes.md')
    assert.match(text, /Quiz "行列式": 1\/2 correct \(50%\) — needs review/)
    assert.match(text, /- \[correct\] which one\?/)
    assert.match(text, /- \[incorrect\] second\n {2}answered: C\n {2}expected: B\n {2}explanation: because B/)
    assert.match(text, /re-teach each weak point with a DIFFERENT explanation/)
    assert.match(text, /Quiz log: edu-notes\/线性代数\/quizzes\.md/)
  })
})
