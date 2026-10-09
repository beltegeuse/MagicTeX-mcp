// Real-TeX backend: compile with a locally installed TeX Live via latexmk, for
// 100% package fidelity (the WASM engine ships a subset). Used by default under
// backend 'auto' when a local TeX is present; 'system' forces it, 'wasm' opts
// out and keeps the zero-install path.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import type { CompileOutput } from './browserHost.js';
import type { Engine } from '../project/compileProject.js';

const pexec = promisify(execFile);

/**
 * What to tell someone who turns out not to have a local TeX.
 *
 * Naming `latexmk` on its own actively misleads: it is not separately
 * installable, it is a Perl driver that ships inside TeX Live. Someone reading
 * "latexmk was not found" goes looking for a package by that name and finds
 * nothing that helps — this happened, and the user came back asking whether they
 * needed "latexmk or the mactex pkg". So name the distribution instead, and say
 * plainly that they may not need one at all.
 */
export const INSTALL_TEX_HELP = [
  "latexmk isn't installed on its own — it ships with a TeX distribution:",
  '  macOS    MacTeX          https://tug.org/mactex/',
  '  Linux    texlive-full    (via your package manager)',
  '  Windows  TeX Live        https://tug.org/texlive/',
  '',
  // Named because it is the common Windows distribution and the one that leaves
  // a latexmk which cannot run: it is a Perl script and MiKTeX ships no Perl.
  // Someone who already has MiKTeX and is told only "install TeX Live" reads
  // that as advice they have already followed.
  'On Windows MiKTeX also works, but only with Perl alongside it —',
  'https://strawberryperl.com/ — because latexmk is a Perl script and MiKTeX',
  'does not ship one. Check with `latexmk -version`, not `which latexmk`: the',
  'file is on PATH either way, and only one of those tells you it can run.',
  '',
  "You don't need one to use MagicTeX: the bundled WASM engine compiles with no",
  'install at all. But it is a subset of TeX Live, so packages like `svg` and most',
  "venue classes aren't in it. Install a distribution when you need output that",
  'matches Overleaf exactly.',
].join('\n');

/**
 * The `\usepackage` name is not always the name you install. `tlmgr install
 * algorithm` fails; the bundle is `algorithms`. Handing someone a command that
 * errors is worse than handing them nothing, so map the cases where the two
 * differ and pass everything else through unchanged.
 */
const CTAN_BUNDLE: Record<string, string> = {
  algorithm: 'algorithms',
  algorithmic: 'algorithms',
  algpseudocode: 'algorithmicx',
  algorithmicx: 'algorithmicx',
  IEEEtran: 'ieeetran',
  llncs: 'llncs',
};

export interface SystemFallback {
  errors: string[];
  missingPackages: string[];
  missingClasses: string[];
  /** Tools the document needs that LaTeX refused to run (svg -> Inkscape,
   *  minted -> Pygments). Carried because this is how a real paper's local-TeX
   *  run actually failed, and without it the caller could say only "it failed
   *  for a different reason" and then trail off — classifyCompile files these
   *  under blockedTools, not errors, so `errors` came back empty. */
  blockedTools?: string[];
}

/**
 * Explain a backend substitution in terms the reader can act on: what their own
 * TeX choked on, what they are looking at instead, and the one command that
 * closes the gap.
 *
 * Without this, `auto` falling back to WASM is indistinguishable from a clean
 * success on the toolchain they configured — which is how a minimal BasicTeX
 * install got reported as "Compile succeeded" while quietly producing output
 * from a different TeX Live than the author believed they were using.
 */
export function systemFallbackNote(f: SystemFallback): string {
  const missing = [...f.missingPackages, ...f.missingClasses];
  const why = missing.length
    ? `${missing.map((m) => `\`${m}\``).join(', ')} not found`
    : (f.errors[0] ?? 'it produced no PDF');
  const packages = [...new Set(missing.map((m) => CTAN_BUNDLE[m] ?? m))];
  const fix = packages.length
    ? `\n\nTo compile with your own TeX instead:\n  tlmgr install ${packages.join(' ')}\n(prefix with sudo on a system-wide TeX Live)`
    : '';
  return `Your local TeX was tried first and failed — ${why}. Fell back to the bundled WASM engine, which got through it, so this PDF exists — but it came from a subset of TeX Live and may not match Overleaf.${fix}`;
}

/**
 * Why the local TeX could not be used. `'absent'` and `'broken'` are different
 * problems with opposite answers, and collapsing them cost a real afternoon: a
 * user installed MiKTeX, MagicTeX went on saying no local TeX was found, and an
 * agent eventually gave up and invoked the compiler itself.
 */
export interface SystemTexProbe {
  usable: boolean;
  reason?: 'absent' | 'broken';
  /** What the OS or the tool actually said. The most useful line available here
   *  is produced by MiKTeX, and used to be discarded by a bare catch. */
  detail?: string;
}

let probe: SystemTexProbe | undefined;

/** Is `latexmk` present AND able to run? */
export async function probeSystemTex(): Promise<SystemTexProbe> {
  // Only a negative result is re-checked, and only that one can change under us:
  // people install TeX while the server is running — often *because* we just
  // told them a package was missing — and this is a long-lived stdio process.
  // A permanent memo meant that install never took effect for the rest of the
  // session, and `backend: "system"` kept reporting "no local TeX was found"
  // about a latexmk sitting on PATH.
  //
  // A positive result is kept: TeX does not uninstall itself mid-session, and
  // re-probing before every compile would spawn a process for nothing.
  if (probe?.usable) return probe;
  try {
    await pexec('latexmk', ['-version'], { timeout: 6000 });
    probe = { usable: true };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // ENOENT is "no such executable". Anything else means latexmk was found and
    // failed to run — on Windows that is nearly always MiKTeX, whose latexmk is
    // a Perl script it ships no interpreter for, so the binary exists and can
    // never execute. Reported as "not found", that sends people off to install
    // a distribution they already have.
    const absent = err.code === 'ENOENT';
    const said = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
    probe = {
      usable: false,
      reason: absent ? 'absent' : 'broken',
      detail: absent ? undefined : said.slice(0, 600) || undefined,
    };
  }
  return probe;
}

/** Is a usable local TeX (latexmk) on PATH? */
export async function hasSystemTex(): Promise<boolean> {
  return (await probeSystemTex()).usable;
}

/** Reset the probe — for tests, and for anything that knows the environment
 *  changed under us. */
export function forgetSystemTex(): void {
  probe = undefined;
}

/**
 * What the reader should do about the local TeX, given what we found when we
 * looked for one. Used when the bundled engine could not compile at all — the
 * moment where "install a TeX distribution" is either the right answer or
 * exactly the wrong one, and the difference is invisible from the log.
 */
export function systemTexAdvice(
  p?: SystemTexProbe,
  ctx: { packages?: string[]; fallback?: SystemFallback } = {},
): string {
  // Two things this got wrong on its first outing against a real paper, both the
  // same mistake — asserting something that had not been measured:
  //
  //   1. Asked for `backend: "wasm"` it said "your local TeX ran and did not get
  //      through this either" about a TeX that was never invoked.
  //   2. Under `auto` it blamed the local TeX's failure on THIS missing package,
  //      when the local TeX had sailed past it and died on something else
  //      entirely (a figure needing shell-escape).
  //
  // So: only the `fallback` — which exists solely when the local TeX actually
  // ran — may be used to say anything about what the local TeX did, and only the
  // packages IT reported missing may be handed to tlmgr.
  const bundle = (n: string) => CTAN_BUNDLE[n] ?? n;
  if (p?.usable) {
    if (!ctx.fallback) {
      return 'You have a working local TeX, and it was not used because this run asked for the bundled engine. Re-run without `backend: "wasm"` — the default picks your local TeX up automatically, and it is likely to have this package.';
    }
    const alsoMissingThere = [...new Set([...ctx.fallback.missingPackages, ...ctx.fallback.missingClasses])]
      .filter((m) => (ctx.packages ?? []).includes(m));
    if (alsoMissingThere.length) {
      return `Your local TeX ran and is missing ${alsoMissingThere.length > 1 ? 'these too' : 'this too'}. Add ${alsoMissingThere.length > 1 ? 'them' : 'it'} with \`tlmgr install ${[...new Set(alsoMissingThere.map(bundle))].join(' ')}\` (prefix with sudo on a system-wide TeX Live).`;
    }
    // The local TeX got past this package and failed on something else. Saying
    // "install it there" would send the reader to fix a problem they do not have.
    // Three sources for "why", in descending order of how much they tell the
    // reader — and a real one for the case where the local run reported nothing
    // at all, which does happen: latexmk on a second run over an existing build
    // directory can fail with a log carrying none of the signatures we classify,
    // leaving every field of the fallback empty. An earlier version trailed off
    // mid-sentence there.
    const why = ctx.fallback.errors[0]
      ? `:\n\n  ${ctx.fallback.errors[0]}`
      : ctx.fallback.blockedTools?.length
        ? `: the document needs ${ctx.fallback.blockedTools.join(', ')}, which LaTeX will not run without shell-escape. Re-run with \`shellEscape: true\` if you trust this source.`
        : ', which it did not report in a form we could read. Re-run with `backend: "system"` to see its output directly.';
    return `Your local TeX ran and got further — it did not report this package missing, so it has it. It failed for a different reason${why}\n\nFixing that is the shorter path to a PDF than getting the bundled engine through this package.`;
  }
  if (p?.reason === 'broken') {
    const perl = /script engine|perl/i.test(p.detail ?? '');
    return [
      'A local TeX would have this package, and MagicTeX uses one automatically when it can.',
      '`latexmk` is on PATH here but could not run:',
      ...(p.detail ? ['', p.detail.split('\n').map((l) => `  ${l}`).join('\n')] : []),
      '',
      ...(perl
        ? ['latexmk is a Perl script and MiKTeX ships no Perl interpreter. Install Strawberry',
           'Perl (https://strawberryperl.com/), or TeX Live for Windows (https://tug.org/texlive/),',
           'which bundles one.']
        : ['Fix that and MagicTeX will pick it up without any further configuration.']),
    ].join('\n');
  }
  return `A local TeX install would have this package, and MagicTeX picks one up automatically once there is one.\n\n${INSTALL_TEX_HELP}`;
}

/**
 * What to say when `backend: "system"` was asked for and cannot be honoured.
 *
 * The two cases need opposite things from the reader and used to get the same
 * sentence. "Found but cannot execute" is the one that reads as a lie, because
 * `latexmk` is right there on PATH.
 */
export function systemTexUnavailableMessage(p: SystemTexProbe): string {
  if (p.reason !== 'broken') {
    return `backend "system" was requested, but no local TeX was found — looked for \`latexmk\` on PATH.\n\n${INSTALL_TEX_HELP}`;
  }
  const perl = /script engine|perl/i.test(p.detail ?? '');
  return [
    'backend "system" was requested. `latexmk` is on PATH but could not run:',
    ...(p.detail ? ['', p.detail.split('\n').map((l) => `  ${l}`).join('\n')] : []),
    '',
    ...(perl
      ? [
          'latexmk is a Perl script, and MiKTeX does not ship a Perl interpreter —',
          'so its latexmk.exe can never execute on its own. Install Strawberry Perl',
          '(https://strawberryperl.com/), or use TeX Live for Windows',
          '(https://tug.org/texlive/), which bundles one.',
          '',
        ]
      : []),
    'Or use backend "wasm", which needs nothing installed.',
  ].join('\n');
}

const ENGINE_FLAG: Record<Engine, string> = {
  xelatex: '-xelatex', lualatex: '-lualatex', pdflatex: '-pdf',
};

/**
 * Stop waiting when latexmk has gone quiet, not when the clock says so.
 *
 * The old limit was a flat 180 s of wall time, which a real paper exceeds
 * without anything being wrong: a multi-pass IEEE build (xelatex → bibtex →
 * xelatex, reloading a large package set each pass, converting figures through
 * Inkscape) simply takes longer than that. Two readers chased phantom LaTeX
 * errors before either noticed the clock was pinned at exactly three minutes.
 *
 * A wedged compile and a slow one are indistinguishable by elapsed time, but not
 * by output: latexmk narrates continuously, and a run blocked on a subprocess
 * that will never return says nothing at all. So the idle timer is the real
 * signal, and the cap is only a backstop against a process that chatters forever.
 */
const IDLE_LIMIT_MS = 120_000;
const HARD_LIMIT_MS = 20 * 60_000;

/**
 * Kill the process and everything it started.
 *
 * `execFile`'s own `timeout` kills only the child it spawned. latexmk is a Perl
 * script that spawns xelatex, which spawns Inkscape — so a timeout left the
 * whole tree running. Measured with a deliberate three-level tree and a 3 s
 * timeout: `killed=true signal=SIGTERM`, and the grandchild still ALIVE. On this
 * machine two failed compiles of one paper left seven live processes holding
 * handles on the build directory, which then slowed the next attempt into
 * timing out as well.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // No process groups; taskkill /T walks the child tree for us.
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    return;
  }
  // Negative pid = the process group, which `detached: true` gave this child.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/** Compile `mainRelPath` (relative to `root`) with local latexmk; artifacts go
 *  under .latex-preview/build so the project tree stays clean.
 *
 *  latexmk runs from the main file's own directory, not the project root: a
 *  document in `lectures/week6/` that says `\input{style}` or
 *  `\graphicspath{{fig/}}` means files next to itself, as under `latexmk -cd`.
 *  The bundled engine already chdirs there, so this keeps the two backends
 *  resolving paths the same way.
 *
 *  Projects written against the old behaviour keep compiling: the root stays on
 *  TEXINPUTS behind the main file's directory, so `\input{lectures/common/x}`
 *  still resolves, and a root latexmkrc is still read unless the main file's
 *  directory has its own. */
export async function compileWithSystemTex(root: string, mainRelPath: string, engine: Engine, shellEscape = false): Promise<CompileOutput> {
  const started = Date.now();
  const outdir = join(root, '.latex-preview', 'build');
  await mkdir(outdir, { recursive: true });
  // resolve, not join: an absolute mainFile names its directory outright.
  const mainDir = resolve(root, dirname(mainRelPath));
  // -shell-escape lets the document execute arbitrary shell commands, so it is
  // opt-in per call rather than a default. Packages like svg and minted cannot
  // work without it, and the user is the only one who can say whether this
  // particular source is trusted.
  const args = [
    ENGINE_FLAG[engine] ?? '-pdf', '-interaction=nonstopmode', '-file-line-error',
    ...(shellEscape ? ['-shell-escape'] : []),
    ...rootRcArgs(root, mainDir),
    `-outdir=${outdir}`, basename(mainRelPath),
  ];

  const { code, out, stopped } = await runLatexmk(mainDir, args, rootOnTexinputs(root, mainDir));

  if (stopped) {
    const waited = Math.round((Date.now() - started) / 1000);
    const why = stopped === 'idle'
      ? `your local TeX produced no output for ${IDLE_LIMIT_MS / 1000}s and was stopped after ${waited}s`
      : `your local TeX was still running after ${waited}s and was stopped`;
    return {
      success: false, exitCode: code ?? 1, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started,
      // Named as a stop, not a failure: the document may be perfectly fine. The
      // usual cause is a subprocess waiting on something — a package installer
      // prompt, or a shell-escape tool the TeX distribution refuses to run.
      error: `The compile was stopped, not finished — ${why}. The document may be fine: a local TeX usually wedges on a subprocess waiting for something (a package-manager prompt, or a shell-escape helper it will not run). Nothing here says your source has an error.`,
    };
  }

  if (code === 0) {
    try {
      const pdfPath = join(outdir, basename(mainRelPath).replace(/\.tex$/i, '') + '.pdf');
      const pdf = new Uint8Array(await readFile(pdfPath));
      return { success: true, exitCode: 0, pdf, pdfLen: pdf.length, log: out, ms: Date.now() - started };
    } catch {
      return { success: false, exitCode: 0, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started, error: 'latexmk reported success but wrote no PDF' };
    }
  }
  return { success: false, exitCode: code ?? 1, pdf: undefined, pdfLen: 0, log: out, ms: Date.now() - started, error: 'system latexmk compile failed' };
}

// latexmk reads the first of these it finds in its working directory.
const RC_NAMES = ['latexmkrc', '.latexmkrc'];

/** `-r <root rc>` when the main file sits below a root that has a latexmkrc and
 *  its own directory has none — latexmk only looks in its working directory, so
 *  moving that into the subdirectory would otherwise drop the root's settings.
 *  A latexmkrc beside the main file is the closer one and wins on its own. */
function rootRcArgs(root: string, mainDir: string): string[] {
  if (resolve(mainDir) === resolve(root)) return [];
  if (RC_NAMES.some((n) => existsSync(join(mainDir, n)))) return [];
  const rc = RC_NAMES.map((n) => join(root, n)).find((p) => existsSync(p));
  return rc ? ['-r', rc] : [];
}

/** The environment for latexmk: TEXINPUTS gets the main file's directory first,
 *  then the project root (not recursively), then whatever was there before — the
 *  trailing empty entry keeps TeX's default search path. */
function rootOnTexinputs(root: string, mainDir: string): NodeJS.ProcessEnv | undefined {
  if (resolve(mainDir) === resolve(root)) return undefined;
  return { ...process.env, TEXINPUTS: ['.', resolve(root), process.env.TEXINPUTS ?? ''].join(delimiter) };
}

/** Run latexmk, collecting output and watching for silence. Resolves rather than
 *  throws: a non-zero exit is an ordinary outcome here, not an exception. */
function runLatexmk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; stopped?: 'idle' | 'cap' }> {
  return new Promise((resolve) => {
    const child = spawn('latexmk', args, {
      cwd,
      env,
      windowsHide: true,
      // POSIX: its own process group, so killTree can take the group down.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let stopped: 'idle' | 'cap' | undefined;
    const CAP = 32 * 1024 * 1024;
    const absorb = (b: Buffer) => {
      if (out.length < CAP) out += b.toString();
      bump();
    };

    let idle: NodeJS.Timeout;
    const stop = (why: 'idle' | 'cap') => {
      stopped = why;
      if (child.pid) killTree(child.pid);
    };
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), IDLE_LIMIT_MS);
    };
    const cap = setTimeout(() => stop('cap'), HARD_LIMIT_MS);

    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    bump();

    child.on('error', (e) => {
      clearTimeout(idle); clearTimeout(cap);
      resolve({ code: 1, out: out + String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(idle); clearTimeout(cap);
      resolve({ code, out, stopped });
    });
  });
}
