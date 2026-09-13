module.exports = {
  testEnvironment: 'node',
  // 2 cores + mongod: jest's default 3 workers oversubscribes the machine and
  // produces transport-level flakes under peak load; 2 is the sweet spot
  maxWorkers: 2,
  // bcrypt is CPU-bound; two workers hashing at once on a low-core dev machine
  // can push a single request past jest's 5s default. Not a product concern
  // (a timeout, never a wrong result) - give the suite headroom.
  testTimeout: 20000,
  setupFiles: ['<rootDir>/tests/setup/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/testServer.ts'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/setup/globalTeardown.ts',
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/tests/**/*.test.(ts|js)'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/types/**'],
  // A RATCHET, not an aspiration: set from measured coverage (2026-09-13:
  // 93.1/77.6/91.2/94.2 across ALL src files) minus a small margin. Raise it
  // when coverage rises; never lower it to make a failing build pass.
  coverageThreshold: {
    global: {
      statements: 91,
      branches: 74,
      functions: 89,
      lines: 92,
    },
  },
};
