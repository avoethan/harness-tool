/**
 * Small interactive prompts for the CLI. Every prompt needs a terminal on
 * both ends; without one the caller must have been given `--yes` or flags.
 */
import * as readline from 'node:readline';

export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Ask without echoing what is typed (for a token). Resolves to the trimmed answer. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (str: string) => {
      if (!asked) {
        process.stdout.write(str);
        return;
      }
      if (str.includes('\n') || str.includes('\r')) process.stdout.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    asked = true;
  });
}

export async function askYesNo(question: string, def = false): Promise<boolean> {
  const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

/** Ask until one of the choices (or its first letter) is typed. Empty input picks `def`. */
export async function askChoice(question: string, choices: string[], def?: string): Promise<string> {
  for (;;) {
    const a = (await ask(`${question} (${choices.join('/')})${def ? ` [${def}]` : ''} `)).toLowerCase();
    if (!a && def) return def;
    const hit = choices.find((c) => c === a || c[0] === a);
    if (hit) return hit;
    process.stdout.write(`please answer one of: ${choices.join(', ')}\n`);
  }
}
