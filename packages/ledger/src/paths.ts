// Repo-root and data-dir resolution shared by the local co-signer and `eng open`.
// A relative DATA_DIR is anchored at the workspace root, not the caller's cwd.
import fs from 'node:fs'
import path from 'node:path'

/** Directory whose package.json lists `workspaces`, walking up from `start`. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start)
  for (;;) {
    const pkgFile = path.join(dir, 'package.json')
    if (fs.existsSync(pkgFile)) {
      let pkg: { workspaces?: unknown }
      try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { workspaces?: unknown }
      } catch {
        throw new Error(`refusing to start: ${pkgFile} is not valid JSON`)
      }
      if (pkg.workspaces) return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('refusing to start: no repo root (package.json with workspaces) found')
    dir = parent
  }
}

/**
 * Relative DATA_DIR is resolved against the repo root, not the caller's cwd.
 * An absolute value is used as given.
 */
export function resolveDataDir(dataDir: string | undefined, root: string): string {
  const raw = dataDir?.trim() || '.cosigner'
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
}
