/** `tsx src/dashboard/index.ts <run-directory>` → `<run-directory>/index.html` */

import fs from 'node:fs'
import { readRun } from './read.ts'
import { build } from './view.ts'
import { page } from './render.ts'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: npm run dashboard -- <run-directory>')
  process.exit(1)
}

const out = `${dir}/index.html`
fs.writeFileSync(out, page(build(readRun(dir))))
console.log(`  → ${out}`)
