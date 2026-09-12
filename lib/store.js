/**
 * The course-file access layer: every read and write a course tool performs
 * goes through here, so resolution, sandbox containment, and observation
 * bookkeeping stay in one place.
 *
 * Two deliberate choices:
 *
 * - Writes are unconditional (`writeText` without a write intent) because these
 *   tools own their files and do their own read-modify-write. The deployment's
 *   read-before-write guard exists for *blind* model edits elsewhere; applying
 *   it here would reject the second append to a file this plugin created.
 *   Instead each read and write emits `fs/observed`, which is exactly the state
 *   that guard reads, so the model's own `write`/`edit` calls stay coherent.
 * - Every path is a workspace-relative path built from the configured notes
 *   directory and a slugified course name. `..` segments are rejected outright
 *   rather than canonicalized, so a notes directory can never escape the
 *   session workspace by configuration.
 */
/** Whether a relative path is safe to resolve under the session workspace. */
function isContainedRelativePath(path) {
    if (path.trim() === '')
        return false;
    if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\'))
        return false;
    return !path.split(/[\\/]+/).includes('..');
}
/**
 * Build the store over the composed filesystem service.
 *
 * @param ctx Plugin context holding `ctx.fs` (and `ctx.sandboxPolicy` when the
 * filesystem backend is confining).
 * @returns The course-file store.
 */
export function createNoteStore(ctx) {
    // A confining backend (dsh-fs-sandbox) resolves the *deployment* default when
    // no policy is passed, which would ignore the session's own workspace root.
    // Mirror the built-in file tools: resolve the session policy per call.
    const policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy');
    if (ctx.fs.sandboxMode !== undefined && policy === undefined) {
        throw new Error('dsh-edu-mode: a confining ctx.fs requires ctx.sandboxPolicy to scope writes to the session workspace');
    }
    /** Resolve one path plus the sandbox policy to hand to the provider. */
    const targetOf = async (path, exec) => {
        if (!isContainedRelativePath(path)) {
            throw new Error(`dsh-edu-mode: "${path}" is not a workspace-relative path; course files stay inside the session workspace`);
        }
        const sandbox = policy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
        const cwd = sandbox?.workspaceRoot ?? exec.agent?.session.header.cwd;
        const target = await ctx.fs.resolve(path, {
            ...cwd === undefined ? {} : { cwd },
            signal: exec.signal,
        });
        return { target, sandbox };
    };
    return {
        async read(path, exec) {
            const { target } = await targetOf(path, exec);
            const info = await ctx.fs.stat(target, exec.signal);
            if (info === undefined)
                return undefined;
            if (info.type !== 'file')
                throw new Error(`"${target.displayPath}" is a ${info.type}, not a file`);
            const text = await ctx.fs.readText(target, exec.signal);
            ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
            return text;
        },
        async write(path, content, exec) {
            const { target, sandbox } = await targetOf(path, exec);
            const outcome = await ctx.fs.writeText(target, content, undefined, exec.signal, sandbox);
            ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
            // Report the path the caller supplied rather than the backend's
            // `displayPath`: a sandboxing backend re-resolves the target and may hand
            // back an absolute path, which would make the same course file read as
            // relative on one write and absolute on the next.
            return { path, operation: outcome.operation };
        },
    };
}
/**
 * Append `chunk` to a file, creating it with `header` when it does not exist.
 *
 * @param store The course-file store.
 * @param path Workspace-relative path.
 * @param chunk Markdown appended after the existing content.
 * @param header Content used when the file is absent.
 * @param exec The running tool call.
 * @returns The touched file plus the text that was there before.
 */
export async function appendFile(store, path, chunk, header, exec) {
    const previous = await store.read(path, exec);
    const body = previous ?? header;
    const separator = body.endsWith('\n') || body === '' ? '' : '\n';
    const file = await store.write(path, `${body}${separator}${chunk}`, exec);
    return { file, previous };
}
