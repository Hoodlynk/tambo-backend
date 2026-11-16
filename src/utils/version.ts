const versionParts = (value: string): number[] => value.split('.').map(Number);

/**
 * Numeric comparison of X.Y.Z versions (no pre-release tags): negative, 0 or
 * positive. Lexical comparison would rank 1.10.0 below 1.9.0.
 */
export const compareVersions = (a: string, b: string): number => {
  const [left, right] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};
