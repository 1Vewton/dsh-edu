/**
 * The bundle contract: what a DSH profile resolves and imports.
 *
 * Two things here have already broken a real installation, so they are pinned
 * by tests rather than by prose: the patch row must name the package the
 * profile resolves, and every bare import in the shipped `lib/` must be a
 * PEER (provided by the harness installation) — never a dependency pnpm would
 * install as a second copy of a module singleton.
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { load } from 'js-yaml'
import plugin, { resolveConfig } from '../lib/index.js'
import { REPO_ROOT } from './helpers.mjs'

const read = relative => readFile(join(REPO_ROOT, relative), 'utf8')
const manifest = JSON.parse(await read('package.json'))
const patchSource = await read('cordis.patch.yml')
const patch = load(patchSource)
const rows = patch.flatMap(entry => entry.insert ?? [])

describe('package manifest', () => {
  it('declares the bundle patch and points at a file that exists', async () => {
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal((await stat(join(REPO_ROOT, 'cordis.patch.yml'))).isFile(), true)
  })

  it('ships everything the loader and the user need', () => {
    for (const entry of ['lib', 'src', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) {
      assert.ok(manifest.files.includes(entry), `${entry} is in "files"`)
    }
  })

  it('declares a helper dependency for the tests, not for the plugin', () => {
    // js-yaml validates shipped YAML in the suite; the plugin must not need it.
    assert.ok(manifest.devDependencies['js-yaml'])
    assert.equal(manifest.dependencies, undefined)
  })

  it('points main and exports at the built entry', async () => {
    assert.equal(manifest.main, 'lib/index.js')
    assert.equal(manifest.exports['.'], './lib/index.js')
    assert.equal((await stat(join(REPO_ROOT, 'lib/index.js'))).isFile(), true)
  })

  it('is a public package that publishes to the registry it declares', () => {
    assert.equal(manifest.private, undefined)
    assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
    assert.equal(manifest.publishConfig.access, 'public')
    // Provenance and trusted publishing both require this to match the repo.
    assert.match(manifest.repository.url, /github\.com\/1Vewton\/dsh-edu/)
  })
})

describe('patch layer', () => {
  it('is one insert of one row naming this package', () => {
    assert.match(patchSource, /^# dsh bundle patch/m)
    assert.equal(patch.length, 1)
    assert.deepEqual(Object.keys(patch[0]), ['insert'])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'edu-mode')
    assert.equal(rows[0].name, manifest.name)
  })

  it('ships a configuration the plugin actually accepts', () => {
    // The same validator the plugin runs at load, over the shipped config: a
    // typo in cordis.patch.yml fails here rather than in a user's profile.
    assert.deepEqual(resolveConfig(rows[0].config), {
      notesDir: 'edu-notes',
      maxQuizQuestions: 6,
      passRatio: 0.8,
    })
  })
})

describe('shipped imports', () => {
  /** Every bare specifier imported by the built output. */
  const shippedImports = async () => {
    const files = (await readdir(join(REPO_ROOT, 'lib'))).filter(name => name.endsWith('.js'))
    const specifiers = new Set()
    for (const file of files) {
      const source = await read(join('lib', file))
      for (const match of source.matchAll(/(?:^|\n)import\s[^'"]*from\s*['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('.')) specifiers.add(match[1])
      }
    }
    return [...specifiers].sort()
  }

  it('imports only harness-provided peers at runtime', async () => {
    const peers = Object.keys(manifest.peerDependencies ?? {})
    assert.deepEqual(await shippedImports(), ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'])
    for (const specifier of await shippedImports()) {
      assert.ok(peers.includes(specifier), `${specifier} is declared as a peer dependency`)
    }
  })

  it('never lists a harness package as a dependency or devDependency-only runtime import', () => {
    // A `dependencies` entry would make pnpm install a second copy of the
    // harness packages next to the installation's own, and the loader would no
    // longer recognise the plugin's service class.
    for (const specifier of Object.keys(manifest.dependencies ?? {})) {
      assert.doesNotMatch(specifier, /^@deepseek-ai\//, `${specifier} must not be a runtime dependency`)
    }
  })

  it('exposes the plugin shape the loader expects', () => {
    assert.equal(plugin.name, 'EduMode')
    assert.deepEqual(plugin.inject, ['tools', 'systemPrompt'])
    assert.equal(typeof plugin, 'function')
  })
})
