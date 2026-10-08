import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function documentPathErrors(root: string): Promise<string[]> {
  const files = ["README.md", "AGENTS.md", ...new Bun.Glob("{doc,tasks}/**/*.md").scanSync({ cwd: root })];
  const errors: string[] = [];
  for (const file of files) {
    const text = await readFile(resolve(root, file), "utf8");
    const paths = new Set<string>();
    const literals = text.replace(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g, (_match, link: string) => {
      const target = link.replace(/^<|>$/g, "");
      if (!/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) {
        paths.add(resolve(root, dirname(file), target.split(/[?#]/)[0]!));
      }
      return "";
    });
    for (const match of literals.matchAll(/(?<![\w/])(?:\.\/)?(?:doc|tasks|scripts|support|web|treatments)\/[^\s"'`\\),;<>]+/g)) {
      const target = match[0].split(/[?#]/)[0]!;
      if (/[*${}]/.test(target)) continue;
      paths.add(resolve(root, target));
    }
    for (const path of paths) {
      try { await access(path); }
      catch { errors.push(`${file}: missing repository path ${path}`); }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = await documentPathErrors(resolve(import.meta.dir, ".."));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Documentation paths are valid.");
}
