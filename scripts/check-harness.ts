/** Run compatibility checks in an isolated copy linked to a built dsh checkout. */
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = resolve(process.env.DSH_HARNESS_DIR ?? join(root, '../deepseek-harness'))
const directory = await mkdtemp(join(tmpdir(), 'dsh-session-fork-check-'))
try {
  const manifest = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
  console.log(`Checking against dsh ${manifest.version} at ${harness}`)
  for (const entry of ['src', 'tests', 'checks', 'package.json', 'tsconfig.json']) {
    await cp(join(root, entry), join(directory, entry), { recursive: true })
  }
  await mkdir(join(directory, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const entry of await readdir(join(root, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry === '.bin') continue
    const owner = ['react', 'react-dom'].includes(entry) ? harness : root
    await symlink(join(owner, 'node_modules', entry), join(directory, 'node_modules', entry))
  }
  const packages: string[] = []
  for (const group of await readdir(join(harness, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(harness, 'packages', group.name), { withFileTypes: true })) {
      if (entry.isDirectory()) packages.push(join(harness, 'packages', group.name, entry.name))
    }
  }
  for (const entry of await readdir(join(harness, 'vendor'), { withFileTypes: true })) {
    if (entry.isDirectory()) packages.push(join(harness, 'vendor', entry.name))
  }
  for (const path of packages) {
    let manifest: { name?: string }
    try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (manifest.name?.startsWith('@deepseek-ai/')) {
      await symlink(path, join(directory, 'node_modules', manifest.name))
    }
  }
  let failed = false
  const commands = [
    ['bun', 'test', 'checks/harness.test.ts'],
    ['node', join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit'],
    ['node', join(root, 'node_modules/typescript/bin/tsc'), '-p', 'src/client/tsconfig.json'],
  ]
  for (const cmd of commands) {
    console.log(`\n$ ${cmd.join(' ')}`)
    const child = Bun.spawn(cmd, {
      cwd: directory,
      env: { ...process.env, DSH_HARNESS_DIR: harness },
      stdout: 'inherit', stderr: 'inherit',
    })
    if (await child.exited !== 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
} finally {
  await rm(directory, { recursive: true, force: true })
}
