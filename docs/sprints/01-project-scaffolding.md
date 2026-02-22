# Sprint 01: Project Scaffolding

**Goal:** Set up the project from zero to a working TypeScript project with all tooling configured.

**RFC Reference:** Section 6 (Opinionated Technology Choices), Section 10.1 (MVP deliverables)

**Depends on:** Nothing. This is the first sprint.

---

## Deliverables

### 1. Initialize npm project

- `package.json` with name `@harnessmaxxing/core`, type `module`
- Node.js 22+ in engines field
- Scripts: `build`, `test`, `typecheck`, `lint`, `dev`

### 2. TypeScript configuration

- `tsconfig.json`: strict mode, ES2022 target, NodeNext module resolution
- Output to `dist/`
- Source maps enabled
- Path aliases: `@/` -> `src/`

### 3. Install dependencies (exact list, nothing more)

**Runtime:**
- `better-sqlite3`
- `ioredis`
- `commander`
- `ink`
- `react`
- `pino`
- `uuid`

**Dev:**
- `typescript`
- `vitest`
- `@types/better-sqlite3`
- `@types/react`
- `fast-check`
- `tsx`
- `@types/node`

### 4. Create directory structure

```
src/
├── index.ts
├── types/
│   └── index.ts
├── lifecycle/
├── agent/
├── heartbeat/
├── checkpoint/
├── bus/
├── supervisor/
├── effects/
├── budget/
└── cli/
test/
├── unit/
├── integration/
├── chaos/
└── helpers/
data/           # SQLite database files (gitignored)
```

Every directory listed above must exist. Directories that have no files yet should contain a `.gitkeep` file so git tracks them. The `src/index.ts` file should export an empty object or a version string. The `src/types/index.ts` file should be empty or contain a placeholder comment.

### 5. Vitest configuration

- `vitest.config.ts` with path aliases matching tsconfig
- Separate test pools for unit (fast) and integration (with Redis/SQLite)
- Coverage enabled

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

### 6. Git setup

- `.gitignore` must include:
  ```
  node_modules/
  dist/
  data/
  *.db
  coverage/
  .DS_Store
  ```
- Initial commit with all scaffolding files

### 7. Smoke test

Create `test/unit/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as core from '@/index';

describe('smoke', () => {
  it('should import the core module', () => {
    expect(core).toBeDefined();
  });
});
```

Both `npm test` and `npm run typecheck` must pass.

---

## Acceptance Criteria

- [ ] `npm install` succeeds with zero errors
- [ ] `npm run typecheck` reports 0 errors
- [ ] `npm test` runs and passes the smoke test
- [ ] Directory structure matches the plan exactly (every directory exists)
- [ ] No extra dependencies beyond the listed ones
- [ ] `tsconfig.json` uses strict mode, ES2022 target, NodeNext module resolution
- [ ] Path alias `@/` resolves to `src/` in both TypeScript and Vitest
- [ ] `.gitignore` excludes node_modules, dist, data/, *.db, coverage/

---

## Estimated Scope

Small. ~15 files, mostly configuration. No business logic.
