/**
 * The course-file store: path containment, workspace resolution, sandbox
 * policy, observation bookkeeping, and the append semantics the course tools
 * build on.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import { appendFile, createNoteStore } from '../lib/store.js'
import {
  fakeAgent,
  fakeContext,
  fakeExec,
  fakeFs,
  fakeSandboxPolicy,
  fakeSession,
  readWorkspaceFile,
  scratchWorkspace,
  workspaceFileExists,
} from './helpers.mjs'

describe('createNoteStore', () => {
  let ws
  let fs
  let ctx
  let session
  let agent
  let exec

  before(async () => {
    ws = await scratchWorkspace('store')
    fs = fakeFs()
    ctx = fakeContext({ fs })
    session = fakeSession({ cwd: ws.dir })
    agent = fakeAgent(session)
    exec = fakeExec(agent)
  })

  after(() => ws.dispose())

  it('creates a file under the session workspace and reports the caller\'s relative path', async () => {
    const store = createNoteStore(ctx)
    const file = await store.write('edu-notes/linear/notes.md', 'first\n', exec)
    assert.deepEqual(file, { path: 'edu-notes/linear/notes.md', operation: 'create' })
    assert.equal(await readWorkspaceFile(ws.dir, 'edu-notes/linear/notes.md'), 'first\n')
  })

  it('reports an existing file as an update', async () => {
    const store = createNoteStore(ctx)
    const file = await store.write('edu-notes/linear/notes.md', 'second\n', exec)
    assert.deepEqual(file, { path: 'edu-notes/linear/notes.md', operation: 'update' })
    assert.equal(await readWorkspaceFile(ws.dir, 'edu-notes/linear/notes.md'), 'second\n')
  })

  it('reads back what it wrote, and reports absence without throwing', async () => {
    const store = createNoteStore(ctx)
    assert.equal(await store.read('edu-notes/linear/notes.md', exec), 'second\n')
    assert.equal(await store.read('edu-notes/linear/missing.md', exec), undefined)
  })

  it('refuses to read a directory as a file', async () => {
    const store = createNoteStore(ctx)
    await assert.rejects(store.read('edu-notes/linear', exec), /is a directory, not a file/)
  })

  it('emits fs/observed for both reads and writes, carrying the write version', async () => {
    const observed = ctx.observed.filter(entry => entry.name === 'fs/observed')
    assert.ok(observed.length >= 2)
    for (const entry of observed) {
      const [target, observation] = entry.args
      assert.equal(target.targetKey.startsWith(ws.dir), true)
      assert.equal(observation.kind, 'present')
      assert.match(observation.version, /^v\d+$/)
    }
  })

  it('resolves every path against the session workspace', () => {
    const last = fs.resolves.at(-1)
    assert.equal(last.opts.cwd, ws.dir)
  })

  it('rejects paths that could escape the workspace, without touching the filesystem', async () => {
    const store = createNoteStore(ctx)
    const before = fs.writes.length
    for (const path of ['../escape.md', 'notes/../../escape.md', '/etc/passwd', 'C:/Windows/system32/x.md', '  ']) {
      await assert.rejects(store.write(path, 'nope\n', exec), /workspace-relative path/)
    }
    assert.equal(fs.writes.length, before)
  })

  it('still works when the caller has no agent, resolving without a workspace root', async () => {
    const store = createNoteStore(ctx)
    const before = fs.resolves.length
    const execWithoutAgent = fakeExec(undefined)
    assert.equal(await store.read('edu-notes/linear/missing.md', execWithoutAgent), undefined)
    const resolve = fs.resolves[before]
    assert.equal(resolve.opts.cwd, undefined)
  })

  it('refuses to load against a confining backend with no sandbox policy', () => {
    const confining = fakeContext({ fs: fakeFs({ sandboxMode: 'workspace-write' }) })
    assert.throws(() => createNoteStore(confining), /requires ctx\.sandboxPolicy/)
  })

  it('resolves the session sandbox policy per call and passes it to the provider', async () => {
    const confiningFs = fakeFs({ sandboxMode: 'workspace-write' })
    const policy = fakeSandboxPolicy({ mode: 'workspace-write' })
    const confiningCtx = fakeContext({ fs: confiningFs, sandboxPolicy: policy })
    const store = createNoteStore(confiningCtx)
    const file = await store.write('edu-notes/confined/notes.md', 'x\n', exec)
    assert.equal(file.operation, 'create')
    assert.equal(policy.requests.length, 1)
    assert.equal(policy.requests[0].session, session)
    assert.equal(confiningFs.writes[0].policy.mode, 'workspace-write')
    assert.equal(confiningFs.writes[0].policy.workspaceRoot, ws.dir)
  })

  it('lets the sandbox policy\'s workspace root win over the session cwd', async () => {
    const root = await scratchWorkspace('policy-root')
    try {
      const rootFs = fakeFs({ sandboxMode: 'workspace-write' })
      const rootCtx = fakeContext({
        fs: rootFs,
        sandboxPolicy: fakeSandboxPolicy({ workspaceRoot: root.dir }),
      })
      await createNoteStore(rootCtx).write('edu-notes/linear/notes.md', 'rooted\n', exec)
      assert.equal(await readWorkspaceFile(root.dir, 'edu-notes/linear/notes.md'), 'rooted\n')
    } finally {
      await root.dispose()
    }
  })
})

describe('appendFile', () => {
  let ws
  let store
  let exec

  before(async () => {
    ws = await scratchWorkspace('append')
    const ctx = fakeContext({ fs: fakeFs() })
    const session = fakeSession({ cwd: ws.dir })
    exec = fakeExec(fakeAgent(session))
    store = createNoteStore(ctx)
  })

  after(() => ws.dispose())

  it('creates the file with the header when it does not exist', async () => {
    const { file, previous } = await appendFile(store, 'notes.md', 'body\n', '# header\n\n', exec)
    assert.deepEqual(previous, undefined)
    assert.equal(file.operation, 'create')
    assert.equal(await readWorkspaceFile(ws.dir, 'notes.md'), '# header\n\nbody\n')
  })

  it('appends to existing content, inserting the missing newline', async () => {
    await store.write('notes.md', '# header\n\nfirst', exec)
    const { file, previous } = await appendFile(store, 'notes.md', 'second\n', '# header\n\n', exec)
    assert.equal(previous, '# header\n\nfirst')
    assert.equal(file.operation, 'update')
    assert.equal(await readWorkspaceFile(ws.dir, 'notes.md'), '# header\n\nfirst\nsecond\n')
  })

  it('does not double the separator when the file already ends in a newline', async () => {
    await store.write('notes.md', 'first\n', exec)
    await appendFile(store, 'notes.md', 'second\n', 'header\n', exec)
    assert.equal(await readWorkspaceFile(ws.dir, 'notes.md'), 'first\nsecond\n')
  })

  it('honours a custom path', async () => {
    await appendFile(store, 'nested/dir/x.md', 'x\n', 'h\n', exec)
    assert.equal(await workspaceFileExists(ws.dir, join('nested', 'dir', 'x.md')), true)
  })
})
