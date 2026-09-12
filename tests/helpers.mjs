/**
 * Test harness for the plugin's host-side code.
 *
 * The suites here drive the REAL plugin code — the same `createNoteStore`,
 * `registerCourseTools` and `registerQuizTool` the harness loads — against a
 * scratch workspace on disk and hand-written doubles for the services the
 * plugin talks to. Everything a double replaces is a seam owned by another
 * package (the filesystem backend, the tool registry, the question channel), so
 * what remains under test is this plugin's own decisions.
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, so a scratch workspace never lands outside the checkout. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Create a scratch workspace directory inside the repository.
 *
 * @param label Short name folded into the directory name.
 * @returns The absolute directory plus its disposer.
 */
export async function scratchWorkspace(label = 'test') {
  const dir = await mkdtemp(join(REPO_ROOT, `.test-tmp-${label}-`))
  return {
    dir,
    /** Remove the workspace and everything in it. */
    async dispose() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Throw when a value is not lossless JSON, mirroring the session log's contract. */
export function assertLosslessJson(value, path = 'value') {
  const seen = new Set()
  const walk = (node, at) => {
    if (node === undefined) throw new Error(`${at} is undefined, which is not lossless JSON`)
    if (typeof node === 'number' && (!Number.isFinite(node) || Object.is(node, -0))) {
      throw new Error(`${at} is not a finite JSON number`)
    }
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
      throw new Error(`${at} is a ${typeof node}, which is not lossless JSON`)
    }
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) throw new Error(`${at} is a circular reference`)
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(node)) walk(item, `${at}.${key}`)
  }
  walk(value, path)
  return value
}

/**
 * A session double: the log the plugin appends `edu/mode` to, plus the header
 * the store reads its workspace root from. `append` enforces the real log's
 * lossless-JSON precondition so a plugin bug cannot pass here and fail live.
 *
 * @param options Scratch workspace as the session cwd.
 * @returns A session-shaped object.
 */
export function fakeSession({ cwd } = {}) {
  const session = {
    id: 'session-1',
    header: { version: 1, id: 'session-1', createdAt: 0, ...cwd === undefined ? {} : { cwd } },
    events: [],
    append(type, data) {
      assertLosslessJson(data, `session event "${type}" data`)
      const event = { type, seq: session.events.length, time: 0, data: JSON.parse(JSON.stringify(data)) }
      session.events.push(event)
      return event
    },
  }
  return session
}

/**
 * An agent double carrying a session, recording what the plugin injects or
 * steers instead of delivering it to a model.
 *
 * @param session The session the agent owns.
 * @returns An agent-shaped object.
 */
export function fakeAgent(session) {
  return {
    id: 'agent-1',
    session,
    injected: [],
    steered: [],
    inject(message) { this.injected.push(message) },
    steer(message) { this.steered.push(message) },
  }
}

/**
 * A `ToolExecutionInput` double. The plugin's tools read only `agent` and
 * `signal`.
 *
 * @param agent The calling agent.
 * @returns An execution-shaped object.
 */
export function fakeExec(agent, { signal = new AbortController().signal } = {}) {
  return { callId: 'call-1', rootCallId: 'call-1', name: 'test', arguments: {}, agent, signal }
}

/**
 * A filesystem backend double over real `node:fs`, shaped like
 * `@deepseek-ai/dsh-fs/local`'s `LocalFileSystem`: `resolve` honours the
 * per-call `cwd`, `writeText` creates parent directories atomically enough for
 * a test, and every write is recorded for assertions.
 *
 * @param options `sandboxMode` to report, and a policy service to resolve.
 * @returns A `ctx.fs`-shaped object.
 */
export function fakeFs({ sandboxMode } = {}) {
  let version = 0
  const writes = []
  const resolves = []
  return {
    ...sandboxMode === undefined ? {} : { sandboxMode },
    writes,
    resolves,
    async resolve(path, opts = {}) {
      resolves.push({ path, opts })
      const absolute = isAbsolute(path) ? path : resolve(opts.cwd ?? process.cwd(), path)
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: `v${version}`,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content, intent, signal, policy) {
      let operation = 'create'
      try {
        await stat(target.targetKey)
        operation = 'update'
      } catch { /* absent: this write creates it */ }
      await mkdir(dirname(target.targetKey), { recursive: true })
      await writeFile(target.targetKey, content, 'utf8')
      version++
      writes.push({ path: target.targetKey, content, operation, intent, policy })
      return { operation, version: `v${version}`, before: null, after: content }
    },
  }
}

/** A sandbox-policy service double recording what it was asked about. */
export function fakeSandboxPolicy({ mode = 'workspace-write', workspaceRoot } = {}) {
  const requests = []
  return {
    requests,
    resolve(request = {}) {
      requests.push(request)
      return {
        mode,
        workspaceRoot: workspaceRoot ?? request.session?.header.cwd,
        ...request.session === undefined ? {} : { sessionId: request.session.id },
      }
    },
  }
}

/**
 * A `ctx` double covering everything `createNoteStore`, `registerCourseTools`
 * and `registerQuizTool` touch, and nothing else.
 *
 * @param options Service doubles to expose.
 * @returns A context-shaped object with the captured registrations.
 */
export function fakeContext({ fs, sandboxPolicy, userQuestions } = {}) {
  const tools = []
  const observed = []
  const ctx = {
    fs,
    tools: { register: definition => { tools.push(definition) } },
    emit(name, ...args) { observed.push({ name, args }) },
    get(name) {
      if (name === 'sandboxPolicy') return sandboxPolicy
      if (name === 'userQuestions') return userQuestions
      return undefined
    },
    toolsList: tools,
    observed,
  }
  return ctx
}

/**
 * A question-channel double: records the request, then answers it with
 * `answers` (keyed by question id) or throws `error`.
 *
 * @param options Canned answers or a thrown failure.
 * @returns A `ctx.userQuestions`-shaped object.
 */
export function fakeUserQuestions({ answers = [], error } = {}) {
  const requests = []
  return {
    requests,
    async ask(request) {
      requests.push(request)
      if (error !== undefined) throw error
      return { answers }
    },
  }
}

/** Read a file inside a scratch workspace. */
export async function readWorkspaceFile(dir, relative) {
  return readFile(join(dir, relative), 'utf8')
}

/** Whether a workspace-relative path exists. */
export async function workspaceFileExists(dir, relative) {
  try {
    await stat(join(dir, relative))
    return true
  } catch {
    return false
  }
}
