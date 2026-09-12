/**
 * Runs every test file inside ONE process.
 *
 * `node --test tests/` would be the idiomatic invocation, but it spawns a child
 * process per file with piped stdio, which confined/sandboxed environments
 * reject (EPERM). Importing the files here behaves identically everywhere and
 * still fails the process on an assertion failure.
 */

await import('./paths.test.js')
await import('./quiz.test.js')
await import('./mode.test.js')
