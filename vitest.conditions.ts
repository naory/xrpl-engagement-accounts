import { defaultServerConditions, type Plugin } from 'vite'

// Dev resolution for packed packages. Their exports map lists "source" first
// (the .ts entry). Vitest 5 / Vite 6 reads conditions from `ssr.resolve`
// and from `resolve`, and a built-in plugin replaces `resolve.conditions`,
// so the same list is applied again in a post plugin.
// "module" is omitted, matching Vitest's server default.
// A parent `tsx --conditions=source` does not put that flag in the environment.
// Children that load .ts must pass `--conditions=source` on their own argv.
export const sourceConditions = [
  'source',
  ...defaultServerConditions.filter((condition) => condition !== 'module'),
  'import',
  'default',
]

export function sourceConditionPlugin(): Plugin {
  return {
    name: 'eng-source-condition',
    enforce: 'post',
    config() {
      return {
        resolve: { conditions: sourceConditions },
        ssr: { resolve: { conditions: sourceConditions } },
        environments: {
          ssr: { resolve: { conditions: sourceConditions } },
        },
      }
    },
  }
}

export function sourceNodeOptions(): string {
  const inherited = process.env.NODE_OPTIONS ?? ''
  const flag = '--conditions=source'
  if (inherited.split(/\s+/).includes(flag)) return inherited
  return [inherited, flag].filter(Boolean).join(' ')
}
