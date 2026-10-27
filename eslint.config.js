import neostandard, { resolveIgnoresFromGitignore } from 'neostandard';

export default [
  { ignores: ['dist/**'] },
  ...neostandard({
    ignores: resolveIgnoresFromGitignore(),
    noJsx: true,
    semi: true,
    ts: true,
  }),
];
