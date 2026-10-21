/** Run a command module's main() with stdout/stderr captured. */
export async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const so = process.stdout.write;
  const se = process.stderr.write;
  (process.stdout as any).write = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as any).write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** Force the TTY flags for a call (node --test runs without a terminal, but be explicit). */
export async function withTty(stdin: boolean, stdout: boolean, fn: () => Promise<void>): Promise<void> {
  const i = (process.stdin as any).isTTY;
  const o = (process.stdout as any).isTTY;
  (process.stdin as any).isTTY = stdin;
  (process.stdout as any).isTTY = stdout;
  try {
    await fn();
  } finally {
    (process.stdin as any).isTTY = i;
    (process.stdout as any).isTTY = o;
  }
}
