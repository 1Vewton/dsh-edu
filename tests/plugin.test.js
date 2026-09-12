/**
 * The plugin as the harness mounts it: a real cordis `Context`, the real
 * service seams (`tools`, `systemPrompt`, `commands`, `fs`), and a real
 * `Session` for the log contract.
 *
 * This is the suite that catches wiring mistakes — a section registered under
 * the wrong name, a command that never lands, a mode switch that logs
 * something the session log rejects — none of which the tool-level suites see.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import EduMode, { foldEduMode, resolveConfig } from '../lib/index.js'
import { renderDefaultPolicy } from '../lib/policy.js'
import {
  fakeAgent,
  fakeExec,
  fakeFs,
  fakeSession,
  scratchWorkspace,
  workspaceFileExists,
} from './helpers.mjs'

/** Mount the real plugin against real cordis with recording service doubles. */
async function bench(config) {
  const ws = await scratchWorkspace('plugin')
  const fs = fakeFs()
  const tools = []
  const sections = []
  const commands = []
  const ctx = new Context()
  ctx.provide('fs', fs)
  ctx.provide('tools', { register: definition => { tools.push(definition) } })
  ctx.provide('systemPrompt', { section: section => { sections.push(section) } })
  ctx.provide('commands', { register: command => { commands.push(command) } })
  await ctx.plugin(EduMode, config)

  const session = fakeSession({ cwd: ws.dir })
  const agent = fakeAgent(session)
  const exec = fakeExec(agent)

  return {
    ws,
    ctx,
    fs,
    tools,
    sections,
    commands,
    session,
    agent,
    exec,
    /** The plugin's own `edu:policy` section. */
    section: () => sections.find(candidate => candidate.name === 'edu:policy'),
    /** The plugin's own `/edu` command. */
    command: () => commands.find(candidate => candidate.name === 'edu'),
    tool: name => tools.find(candidate => candidate.name === name),
    /** Dispatch a `/edu` invocation the way the command runtime would. */
    run: (rawInput, attachments = []) => commands
      .find(candidate => candidate.name === 'edu')
      .handler({ agent, rawInput, attachments }),
    async dispose() { await ws.dispose() },
  }
}

/** Append a `request/header` so the log has a "what the model was told" anchor. */
function header(session) {
  session.append('request/header', { header: { config: { provider: 'test', model: 'test-model' } }, reason: 'initial' })
}

describe('plugin wiring', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.dispose())

  it('exposes the mode service on the context', () => {
    assert.equal(typeof b.ctx.eduMode.set, 'function')
    assert.equal(typeof b.ctx.eduMode.get, 'function')
    assert.equal(typeof b.ctx.eduMode.courseOf, 'function')
  })

  it('registers all three education tools', () => {
    assert.deepEqual(b.tools.map(tool => tool.name).sort(), ['edu_course', 'edu_notes', 'edu_quiz'])
  })

  it('registers the guidance section under its own name and order', () => {
    const section = b.section()
    assert.ok(section, 'edu:policy was registered')
    assert.equal(section.order, 51)
    assert.equal(typeof section.text, 'function')
  })

  it('registers the /edu command with its hint', () => {
    const command = b.command()
    assert.ok(command, '/edu was registered')
    assert.equal(command.description, 'Enter or leave education mode')
    assert.deepEqual(command.input, { hint: '[off|status|course]', images: true })
  })
})

describe('the guidance section', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.dispose())

  it('is empty while the mode is off, and states the course while it is on', async () => {
    const context = { agent: b.agent }
    assert.equal(b.section().text(context), '')

    header(b.session)
    b.run('Linear Algebra')
    const text = b.section().text(context)
    assert.match(text, /education mode: the user asked you to TEACH them a subject/)
    assert.match(text, /# Active course\n\nLinear Algebra/)
    assert.match(text, /`edu-notes\/<course>\/`/)
    assert.match(text, /edu_quiz/)
    assert.equal(renderDefaultPolicy({ notesDir: 'edu-notes', maxQuizQuestions: 6 }).includes('{{'), false)
  })

  it('is empty again after leaving, and for a call with no agent', async () => {
    b.run('off')
    assert.equal(b.section().text({ agent: b.agent }), '')
    assert.equal(b.section().text({}), '')
  })

  it('carries a deployment-supplied policy instead of the default', async () => {
    const custom = await bench({ notesDir: 'notes', policy: 'Teach slowly.' })
    try {
      custom.run('Topology')
      const text = custom.section().text({ agent: custom.agent })
      assert.match(text, /^Teach slowly\./)
      assert.doesNotMatch(text, /the user asked you to TEACH them a subject/)
    } finally {
      await custom.dispose()
    }
  })
})

describe('/edu', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.dispose())

  it('enters the mode with a course, steering the text to the model', () => {
    header(b.session)
    const result = b.run('  线性代数  ')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Education mode on for "线性代数"/)
    assert.match(result.text, /edu_quiz/)
    assert.equal(b.agent.steered.length, 1)
    assert.equal(b.agent.steered[0].content.at(-1).text, '线性代数')
    assert.deepEqual(b.ctx.eduMode.get(b.agent), { active: true, course: '线性代数' })
    assert.deepEqual(foldEduMode(b.session.events), { active: true, course: '线性代数' })
  })

  it('narrates the switch to the model once the log says otherwise', () => {
    const notice = b.agent.injected.at(-1)
    assert.equal(notice.source.kind, 'plugin')
    assert.equal(notice.source.plugin, 'dsh-edu-mode')
    assert.match(notice.content[0].text, /switched this session to education mode for the course "线性代数"/)
  })

  it('reports the state for /edu status', () => {
    assert.match(b.run('status').text, /Education mode is on — course "线性代数"\. Notes go to edu-notes\/\./)
    assert.equal(b.run('off').text, 'Education mode off.')
    assert.match(b.run('status').text, /Education mode is off\. Use \/edu <course> to start a course\./)
  })

  it('enters without a course, and is idempotent', () => {
    assert.equal(b.run('').text, 'Education mode on: research it, teach it, write the class notes with edu_notes, then quiz with edu_quiz. Use /edu off to leave.')
    assert.equal(b.run('').text, 'Education mode is already on.')
    assert.equal(b.run('off').text, 'Education mode off.')
    assert.equal(b.run('off').text, 'Education mode is already off.')
  })

  it('refuses attachments on /edu off', () => {
    const result = b.run('off', [{ type: 'image', mimeType: 'image/png', data: 'x' }])
    assert.deepEqual(result, { kind: 'error', text: 'Image attachments cannot accompany /edu off.' })
  })
})

describe('mode state transitions', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.dispose())

  it('commits immediately between turns', () => {
    assert.equal(b.ctx.eduMode.set(b.agent, { active: true, course: 'Sets' }), 'committed')
    assert.deepEqual(foldEduMode(b.session.events), { active: true, course: 'Sets' })
    assert.equal(b.ctx.eduMode.set(b.agent, { active: true, course: 'Sets' }), 'noop')
    assert.equal(b.ctx.eduMode.set(b.agent, { active: true, course: 'Groups' }), 'committed')
    assert.equal(b.ctx.eduMode.courseOf(b.agent), 'Groups')
  })

  it('queues a switch made inside an open turn and keeps it out of the log', () => {
    const session = fakeSession({ cwd: b.ws.dir })
    const agent = fakeAgent(session)
    session.append('turn/start', { turn: 1 })
    assert.equal(b.ctx.eduMode.set(agent, { active: true, course: 'Topology' }), 'queued')
    assert.deepEqual(foldEduMode(session.events), { active: false })
    assert.deepEqual(b.ctx.eduMode.get(agent), { active: true, course: 'Topology', pending: true })
    // The pending selection is the answer tools must use, so a quiz in the same
    // turn still logs against the course the user just asked for.
    assert.equal(b.ctx.eduMode.courseOf(agent), 'Topology')
  })

  it('drops a queued switch that the log already satisfies', () => {
    const session = fakeSession({ cwd: b.ws.dir })
    const agent = fakeAgent(session)
    session.append('turn/start', { turn: 1 })
    assert.equal(b.ctx.eduMode.set(agent, { active: true, course: 'Topology' }), 'queued')
    assert.equal(b.ctx.eduMode.set(agent, { active: false }), 'cancelled')
    assert.deepEqual(b.ctx.eduMode.get(agent), { active: false })
    assert.deepEqual(foldEduMode(session.events), { active: false })
  })

  it('reports a detached caller instead of switching anything', () => {
    assert.equal(b.ctx.eduMode.courseOf(undefined), undefined)
    assert.equal(b.ctx.eduMode.setCourse(undefined, 'Nowhere'), 'detached')
  })
})

describe('the session log contract', () => {
  it('round-trips an edu/mode event through the real Session log', () => {
    const session = Session.create(SessionId('edu-log-contract'))
    session.append('edu/mode', { active: true, course: '线性代数' })
    session.append('edu/mode', { active: false })
    assert.deepEqual(foldEduMode(session.events.slice(0, 1)), { active: true, course: '线性代数' })
    assert.deepEqual(foldEduMode(session.events), { active: false })
  })

  it('rejects the shape a careless implementation would log', () => {
    const session = Session.create(SessionId('edu-log-rejects-undefined'))
    assert.throws(
      () => session.append('edu/mode', { active: true, course: undefined }),
      /non-JSON-serializable/,
    )
  })
})

describe('the plugin drives its own tools', () => {
  let b
  before(async () => { b = await bench() })
  after(() => b.dispose())

  it('opens a course through the registered tool, in the session workspace, and activates the mode', async () => {
    header(b.session)
    const value = await b.tool('edu_course').execute({
      action: 'open',
      course: 'Plugin Probe',
      goal: 'verify the wiring',
      modules: [{ id: 'm1', title: 'Orbits' }],
    }, b.exec)

    assert.equal(value.syllabus, 'edu-notes/Plugin-Probe/syllabus.md')
    assert.equal(await workspaceFileExists(b.ws.dir, 'edu-notes/Plugin-Probe/syllabus.md'), true)
    // The tool opened the course, which is what switches the session on.
    assert.deepEqual(foldEduMode(b.session.events), { active: true, course: 'Plugin Probe' })
    assert.equal(b.ctx.eduMode.courseOf(b.agent), 'Plugin Probe')
    assert.match(b.section().text({ agent: b.agent }), /# Active course\n\nPlugin Probe/)
  })

  it('writes the notes the section promises, in the same workspace', async () => {
    const value = await b.tool('edu_notes').execute({ lesson: 'L1 · Orbits', markdown: 'An orbit is an ellipse.' }, b.exec)
    assert.equal(value.path, 'edu-notes/Plugin-Probe/notes.md')
    assert.equal(await workspaceFileExists(b.ws.dir, 'edu-notes/Plugin-Probe/notes.md'), true)
  })

  it('defaults the quiz to the course the mode is teaching', async () => {
    const value = await b.tool('edu_quiz').execute({
      topic: 'orbits',
      questions: [{ question: 'Is a circle an ellipse?', options: ['yes', 'no'], answer: ['yes'] }],
    }, b.exec)
    // No question channel is provided in this bench, so the quiz degrades — but
    // it still resolved the course from the mode.
    assert.equal(value.status, 'no_channel')
    assert.equal(value.course, 'Plugin Probe')
  })
})

describe('configuration', () => {
  /** Mount the plugin on a fresh context, wire-only, and return the promise. */
  const mountWith = (config) => {
    const ctx = new Context()
    ctx.provide('tools', { register: () => {} })
    ctx.provide('systemPrompt', { section: () => {} })
    return ctx.plugin(EduMode, config)
  }

  it('refuses to mount with an unusable configuration', async () => {
    // `ctx.plugin()` hands back a Fiber, not a promise, so each assertion awaits
    // the mount explicitly.
    await assert.rejects(async () => { await mountWith({ notesDir: '../outside' }) }, /workspace-relative/)
    await assert.rejects(async () => { await mountWith({ notesDir: 'C:/tmp' }) }, /workspace-relative/)
    await assert.rejects(async () => { await mountWith({ maxQuizQuestions: 99 }) }, /maxQuizQuestions/)
    await assert.rejects(async () => { await mountWith({ passRatio: 0 }) }, /passRatio/)
    await assert.rejects(async () => { await mountWith({ nope: true }) }, /unknown key/)
  })

  it('mounts with a deployment configuration and reports it', async () => {
    const b = await bench({ notesDir: 'notes', maxQuizQuestions: 3, passRatio: 0.5 })
    try {
      assert.deepEqual(b.ctx.eduMode.config, { notesDir: 'notes', maxQuizQuestions: 3, passRatio: 0.5 })
      assert.deepEqual(resolveConfig(), { notesDir: 'edu-notes', maxQuizQuestions: 6, passRatio: 0.8 })
    } finally {
      await b.dispose()
    }
  })
})
