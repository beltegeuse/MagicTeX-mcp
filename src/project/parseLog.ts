// Turn a raw TeX/busytex log into structured errors so render_preview can hand
// Claude something it can act on directly ({file, line, message}) instead of a
// wall of log text.
import { posix } from 'node:path';

export interface TexError {
  file?: string;
  line?: number;
  message: string;
}

// "./main.tex:42: Undefined control sequence" — file:line:message form.
const FILE_LINE = /^(?:\.\/)?([^\s:]+\.\w+):(\d+):\s*(.+)$/;
// "! LaTeX Error: ..." / "! Undefined control sequence." / "! Package X Error: ..."
const BANG = /^!\s+(.*)$/;
// "l.42 \something" — the line number TeX reports for the current error.
const L_LINE = /^l\.(\d+)\b/;

/**
 * `baseDir` is the main file's directory relative to the project root. TeX runs
 * from there, so the paths it prints are relative to it; joining them back onto
 * it reports `chapters/intro.tex` rather than an `intro.tex` the reader has to
 * go looking for.
 */
export function parseTexLog(log: string, baseDir?: string): TexError[] {
  const rebase = (file: string) =>
    baseDir && baseDir !== '.' && !posix.isAbsolute(file) ? posix.join(baseDir, file) : file;
  const lines = log.split(/\r?\n/);
  const errors: TexError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fl = line.match(FILE_LINE);
    if (fl) {
      errors.push({ file: rebase(fl[1]), line: Number(fl[2]), message: fl[3].trim() });
      continue;
    }

    const bang = line.match(BANG);
    if (bang) {
      let message = bang[1].trim();
      let lineNo: number | undefined;
      // Look ahead a few lines for the "l.<N>" that pins the location, and for a
      // continuation of the message.
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const l = lines[j].match(L_LINE);
        if (l) { lineNo = Number(l[1]); break; }
        // A blank line ends the error block.
        if (lines[j].trim() === '') break;
      }
      errors.push({ line: lineNo, message });
    }
  }

  // De-dup identical consecutive messages (TeX often repeats).
  return errors.filter((e, idx) => idx === 0 || e.message !== errors[idx - 1].message);
}

/** Compact, model-friendly summary. Falls back to the log tail if unparseable. */
export function summarizeErrors(log: string, baseDir?: string): string {
  const errors = parseTexLog(log, baseDir);
  if (errors.length === 0) {
    const tail = log.slice(-1500).trim();
    return tail ? `No structured errors parsed. Log tail:\n${tail}` : 'Compile failed with no log output.';
  }
  const shown = errors.slice(0, 10);
  const lines = shown.map((e) => {
    const loc = e.file ? `${e.file}${e.line ? ':' + e.line : ''}` : e.line ? `line ${e.line}` : '?';
    return `  • [${loc}] ${e.message}`;
  });
  const more = errors.length > shown.length ? `\n  … and ${errors.length - shown.length} more` : '';
  return `${errors.length} error${errors.length === 1 ? '' : 's'}:\n${lines.join('\n')}${more}`;
}
