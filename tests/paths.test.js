import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  courseLayout,
  parseModules,
  renderNoteSection,
  renderQuizSection,
  renderSyllabus,
  slugifyCourse,
  stamp,
  toggleModule,
  upsertSection,
} from '../lib/paths.js'

describe('slugifyCourse', () => {
  it('keeps CJK course names readable', () => {
    assert.equal(slugifyCourse('线性代数'), '线性代数')
  })

  it('collapses whitespace and path-hostile characters', () => {
    assert.equal(slugifyCourse('  Intro to   Linear/Algebra  '), 'Intro-to-Linear-Algebra')
    assert.equal(slugifyCourse('C++: 模板<进阶>'), 'C++-模板-进阶')
  })

  it('never returns an empty or traversing segment', () => {
    assert.equal(slugifyCourse('   '), 'course')
    assert.equal(slugifyCourse('..'), 'course')
    assert.equal(slugifyCourse('../../etc'), 'etc')
  })

  it('caps the segment length', () => {
    assert.ok(slugifyCourse('x'.repeat(500)).length <= 60)
  })
})

describe('courseLayout', () => {
  it('nests the three course files under the notes root', () => {
    assert.deepEqual(courseLayout('edu-notes', '线性代数'), {
      dir: 'edu-notes/线性代数',
      syllabus: 'edu-notes/线性代数/syllabus.md',
      notes: 'edu-notes/线性代数/notes.md',
      quizzes: 'edu-notes/线性代数/quizzes.md',
    })
  })

  it('tolerates a trailing separator in the configured root', () => {
    assert.equal(courseLayout('notes/', 'x').syllabus, 'notes/x/syllabus.md')
  })
})

describe('syllabus', () => {
  const syllabus = renderSyllabus({
    course: '线性代数',
    goal: '看懂机器学习里的矩阵推导',
    level: '已学过微积分',
    modules: [
      { id: 'm1', title: '行列式', objectives: ['手算 3 阶行列式'] },
      { id: 'm2', title: '特征值' },
    ],
    sources: [{ title: 'MIT 18.06', url: 'https://ocw.mit.edu/18-06' }],
    date: '2026-02-14',
  })

  it('renders the goal, level, modules and sources', () => {
    assert.match(syllabus, /^# 线性代数$/m)
    assert.match(syllabus, /看懂机器学习里的矩阵推导/)
    assert.match(syllabus, /已学过微积分/)
    assert.match(syllabus, /- \[ \] m1 · 行列式\n {3}- 手算 3 阶行列式/)
    assert.match(syllabus, /- \[ \] m2 · 特征值/)
    assert.match(syllabus, /\[MIT 18\.06\]\(https:\/\/ocw\.mit\.edu\/18-06\)/)
  })

  it('renders completed modules as checked boxes', () => {
    const rewritten = renderSyllabus({
      course: '线性代数',
      modules: [
        { id: 'm1', title: '行列式', done: true },
        { id: 'm2', title: '特征值', done: false },
      ],
      date: '2026-02-14',
    })
    assert.match(rewritten, /- \[x\] m1 · 行列式/)
    assert.match(rewritten, /- \[ \] m2 · 特征值/)
  })

  it('round-trips through parseModules and toggleModule', () => {
    assert.deepEqual(parseModules(syllabus).map(m => [m.id, m.done]), [['m1', false], ['m2', false]])
    const checked = toggleModule(syllabus, 'm1', true)
    assert.equal(checked.changed, true)
    assert.deepEqual(parseModules(checked.text).map(m => [m.id, m.done]), [['m1', true], ['m2', false]])
    assert.equal(toggleModule(checked.text, 'm2', false).changed, true)
    assert.equal(toggleModule(syllabus, 'nope', true).changed, false)
  })

  it('does not confuse a prefix identifier with the module it prefixes', () => {
    const doc = '- [ ] m1 · a\n- [ ] m10 · b'
    const toggled = toggleModule(doc, 'm1', true)
    assert.match(toggled.text, /- \[x\] m1 · a/)
    assert.match(toggled.text, /- \[ \] m10 · b/)
  })
})

describe('upsertSection', () => {
  it('appends a new lesson section', () => {
    const result = upsertSection('', 'L1', '## L1\n\nbody\n', false)
    assert.equal(result.kind, 'written')
    assert.equal(result.action, 'appended')
    assert.equal(result.text, '## L1\n\nbody\n')
  })

  it('refuses a duplicate lesson unless replace is set', () => {
    const doc = '## L1\n\nold\n'
    assert.equal(upsertSection(doc, 'L1', '## L1\n\nnew\n', false).kind, 'duplicate')
    const replaced = upsertSection(doc, 'L1', '## L1\n\nnew\n', true)
    assert.equal(replaced.kind, 'written')
    assert.equal(replaced.action, 'replaced')
    assert.equal(replaced.text, '## L1\n\nnew\n')
  })

  it('replaces only the matching section and keeps its neighbours', () => {
    const doc = '## L1\n\nfirst\n\n## L2\n\nsecond\n'
    const replaced = upsertSection(doc, 'L1', '## L1\n\nrewritten\n', true)
    assert.equal(replaced.text, '## L1\n\nrewritten\n\n## L2\n\nsecond\n')
  })

  it('appends after existing content', () => {
    const result = upsertSection('## L1\n\nfirst\n', 'L2', '## L2\n\nsecond\n', false)
    assert.equal(result.text, '## L1\n\nfirst\n\n## L2\n\nsecond\n')
  })
})

describe('note and quiz rendering', () => {
  it('renders the optional note sections only when present', () => {
    const note = renderNoteSection({
      lesson: '第 1 讲',
      body: '正文',
      keyPoints: ['a'],
      sources: [{ title: 'T', url: 'https://e.x' }],
      date: '2026-02-14',
    })
    assert.match(note, /^## 第 1 讲\n\n> 2026-02-14\n\n正文/)
    assert.match(note, /### Key points\n\n- a/)
    assert.match(note, /### Sources\n\n- \[T\]\(https:\/\/e\.x\)/)
    assert.doesNotMatch(note, /Common misconceptions/)
  })

  it('marks a quiz row per verdict and keeps the expected answer only when it matters', () => {
    const section = renderQuizSection({
      topic: '行列式',
      score: 0.5,
      correct: 1,
      gradable: 2,
      passed: false,
      entries: [
        { question: 'q1', verdict: 'correct', responded: 'A', expected: 'A' },
        { question: 'q2', verdict: 'incorrect', responded: 'B', expected: 'C' },
      ],
      date: '2026-02-14',
    })
    assert.match(section, /^## 行列式 — 1\/2 \(50%\) · needs review/)
    assert.match(section, /- ✅ q1\n {2}- answered: A\n/)
    assert.match(section, /- ❌ q2\n {2}- answered: B\n {2}- expected: C/)
  })

  it('stamps a local date', () => {
    assert.equal(stamp(new Date(2026, 1, 14, 23, 30)), '2026-02-14')
  })
})
