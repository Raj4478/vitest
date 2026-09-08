import { expect, test } from 'vitest'
import { runInlineTests, runVitestCli } from '../../test-utils'

test.each([true, false])('doctor measures custom environments with setupVM: %s', async (supportsVm) => {
  const { root, stderr, testTree } = await runInlineTests({
    'vitest.config.ts': `
      import { defineConfig } from 'vitest/config'
      export default defineConfig({
        test: {
          environment: './custom-env.ts',
          pool: 'threads',
          isolate: false,
          fsModuleCache: true,
          maxWorkers: 1,
        },
      })
    `,
    'custom-env.ts': `
      import { builtinEnvironments } from 'vitest/runtime'
      const happyDom = builtinEnvironments['happy-dom']
      export default {
        ...happyDom,
        name: 'happy-dom-broadcast-channel',
        setupVM: ${supportsVm
          ? `async (options) => {
          const result = await happyDom.setupVM(options)
          result.getVmContext().BroadcastChannel = BroadcastChannel
          return result
        }`
          : 'undefined'},
      }
    `,
    'dom.test.ts': `
      import { expect, test } from 'vitest'
      test('custom DOM environment', () => {
        expect(document.createElement('div').tagName).toBe('DIV')
        expect(typeof BroadcastChannel).toBe('function')
      })
    `,
  })
  expect(stderr).toBe('')
  expect(testTree()).toMatchInlineSnapshot(`
    {
      "dom.test.ts": {
        "custom DOM environment": "passed",
      },
    }
  `)

  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: root } },
    'doctor',
  )
  await waitForClose()
  expect(vitest.stderr).toBe('')
  expect(exitCode).toBe(0)

  for (const pool of ['vmThreads', 'vmForks']) {
    expect(vitest.stdout.match(new RegExp(`measuring pool: '${pool}'`, 'g'))).toEqual([`measuring pool: '${pool}'`])
    if (supportsVm) {
      expect(vitest.stdout).toMatch(new RegExp(`pool: '${pool}'\\s+\\d`))
      expect(vitest.stdout).not.toMatch(new RegExp(`pool: '${pool}' failed`))
    }
    else {
      expect(vitest.stdout).toMatch(new RegExp(`pool: '${pool}' failed with:`))
      expect(vitest.stdout).toMatch(/doesn't support vm environment because it doesn't provide "setupVM" method/)
      expect(vitest.stdout).not.toMatch(/Recommendation: pool: 'vm/)
    }
  }
}, 120_000)

test('doctor measures alternative configurations and reports a table', async () => {
  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: 'fixtures/doctor' } },
    'doctor',
  )

  await waitForClose()

  expect(vitest.stderr).toBe('')
  expect(exitCode).toBe(0)

  const stdout = vitest.stdout
  expect(stdout).toContain('measuring baseline (pool: forks · isolate: true)')
  // node environment on forks: threads and isolate:false are worth measuring
  expect(stdout).toContain(`measuring pool: 'threads'`)
  expect(stdout).toContain('measuring isolate: false')
  // the fs module cache is off, so persisting transforms is worth measuring
  expect(stdout).toContain('measuring fsModuleCache: true')
  // the DOM candidates are not: there is nothing to amortize or swap
  expect(stdout).not.toContain('vmThreads')
  expect(stdout).not.toContain('vmForks')
  expect(stdout).not.toContain('happy-dom')

  expect(stdout).toContain('Results (min of 3 runs each)')
  expect(stdout).toMatch(/Recommendation: /)
}, 120_000)

test('doctor swaps the environment per project', async () => {
  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: 'fixtures/doctor-projects' } },
    'doctor',
  )

  await waitForClose()

  expect(vitest.stderr).toBe('')
  expect(exitCode).toBe(0)

  const stdout = vitest.stdout
  // only the jsdom project is swapped: the node project asserts that no DOM
  // leaked into it, so a workspace-wide override would fail this candidate
  expect(stdout).toContain(`measuring environment: 'happy-dom'`)
  expect(stdout).not.toContain(`environment: 'happy-dom' failed`)
  expect(stdout).toMatch(/environment: 'happy-dom'\s+\d/)
}, 120_000)

test('doctor reports the errors of failing candidates', async () => {
  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: 'fixtures/doctor-failing' } },
    'doctor',
  )

  await waitForClose()

  expect(exitCode).toBe(0)

  const stdout = vitest.stdout
  // the DOM environment makes the vm pools candidates, and the fixture fails under both
  expect(stdout).toContain(`pool: 'vmThreads' failed with:`)
  expect(stdout).toContain(`pool: 'vmForks' failed with:`)
  expect(stdout).toContain('FAIL  vm-hostile.test.ts > does not run under a vm pool')
  // the failing candidates are never recommended
  expect(stdout).not.toMatch(/Recommendation: pool: 'vm/)
  // an all-jsdom suite also measures the happy-dom swap
  expect(stdout).toContain(`measuring environment: 'happy-dom'`)
}, 120_000)
