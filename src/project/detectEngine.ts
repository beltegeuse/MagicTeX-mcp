// Which TeX engine a document asks for, read from its own source.
import type { Engine } from './compileProject.js';
import { DOCUMENTCLASS } from './resolveMainFile.js';

// A `% !TEX program = pdflatex` line before \documentclass — the magic comment
// TeXstudio, TeXShop and LaTeX Workshop already honour — names the engine a
// document was written for. Without one, xelatex: broadest font/UTF-8 support.
// An explicit `engine` from the caller still wins over both.
// TeXShop's latexmk variants (`pdflatexmk`, `xelatexmk`) name the same engine.
const MAGIC_PROGRAM = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)(?:mk)?\b/im;

export function detectEngine(src: string): Engine {
  const docclass = src.search(DOCUMENTCLASS);
  const header = docclass === -1 ? src : src.slice(0, docclass);
  const magic = header.match(MAGIC_PROGRAM);
  return magic ? (magic[1].toLowerCase() as Engine) : 'xelatex';
}
