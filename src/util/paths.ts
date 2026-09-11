import { isAbsolute, relative, resolve } from 'node:path'

export function assertInside(root: string, target: string): string {
  const resolvedRoot = resolve(root)
  const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${target}`)
  }
  return resolvedTarget
}
