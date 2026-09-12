/**
 * The curated-registry submission behind dsh-market.
 *
 * dsh-market installs only from https://awesome-dsh-plugin.com/plugins.json, and
 * that catalog is generated from `data/plugins/<owner>__<repo>.yml` in
 * awesome-dsh-plugin/awesome-dsh-plugin. The entry is one small YAML file, so
 * the registry's stated rules are cheap to encode here — and the claims in it
 * are claims about this code, which is exactly what the reviewers check.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { REPO_ROOT } from './helpers.mjs'

const read = relative => readFile(join(REPO_ROOT, relative), 'utf8')
const manifest = JSON.parse(await read('package.json'))
const entry = load(await read('contrib/awesome-dsh-plugin/1Vewton__dsh-edu.yml'))

/** Categories the registry accepts (contributing.md). */
const CATEGORIES = new Set([
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
  'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
  'dev', 'security', 'remote', 'market', 'fun',
])

/** The repository URL without git's transport decoration. */
const REPOSITORY_URL = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

describe('registry entry', () => {
  it('names the repository exactly as the registry requires', () => {
    assert.equal(entry.url, REPOSITORY_URL)
    assert.equal(entry.name, '1Vewton/dsh-edu')
    // The submission file is named after the repo: <owner>__<repo>.yml
    assert.equal(`${entry.name.replace('/', '__')}.yml`, '1Vewton__dsh-edu.yml')
  })

  it('uses one of the accepted categories', () => {
    assert.ok(CATEGORIES.has(entry.category), `"${entry.category}" is a registry category`)
  })

  it('describes what the plugin does, in both languages, without marketing', () => {
    assert.equal(typeof entry.description.en, 'string')
    assert.match(entry.description.en, /\.$/)
    assert.match(entry.description.zh, /。$/)
    assert.doesNotMatch(entry.description.en, /\b(best|fastest|amazing|revolutionary|ultimate|powerful)\b/i)
    assert.doesNotMatch(entry.description.zh, /(最强|最好|革命性|无敌)/)
  })

  it('only claims tools the plugin registers', async () => {
    const registration = (await Promise.all(
      ['lib/course.js', 'lib/quiz.js'].map(file => read(file)),
    )).join('')
    const names = [...registration.matchAll(/name: '(edu_\w+)'/g)].map(match => match[1]).sort()
    assert.deepEqual(names, ['edu_course', 'edu_notes', 'edu_quiz'])
    // The description states the count, so the count has to match.
    assert.match(entry.description.en, new RegExp(`\\b${['one', 'two', 'three'][names.length - 1]} tools\\b`))
  })

  it('points at a prebuilt tarball whose asset name cannot rot', () => {
    assert.equal(
      entry.tarball,
      `https://github.com/1Vewton/dsh-edu/releases/latest/download/${manifest.name}.tgz`,
    )
    const asset = entry.tarball.split('/').at(-1)
    assert.equal(asset, `${manifest.name}.tgz`)
    // `latest/download/<name>` takes the filename literally: a version in it
    // would 404 the moment the next release ships.
    assert.doesNotMatch(asset, new RegExp(manifest.version.replace(/\./g, '\\.')))
  })

  it('keeps the registry\'s prerequisites satisfied by the manifest', () => {
    // 1. installable via `dsh plugin add` (the registry's hard requirement)
    assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
    // 2. real code, and the npm package links back to this repository
    assert.ok(manifest.repository.url.includes('github.com/1Vewton/dsh-edu'))
    assert.equal(manifest.license, 'MIT')
  })
})
