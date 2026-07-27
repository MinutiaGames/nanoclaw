/**
 * Unit test for the opencode provider's host-side env passthrough
 * (OPENCODE_ENV_KEYS in opencode.ts). Added 2026-07-27 after
 * OPENCODE_IDLE_TIMEOUT_MS was set in .env but silently never reached the
 * container — the container-side code reads it from process.env, but the
 * host only forwards vars listed in OPENCODE_ENV_KEYS, and this one had
 * been left off. Goes red if a var relied on by the container falls off
 * this list again.
 */
import { describe, it, expect } from 'vitest';

import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js'; // self-registers the opencode provider

describe('opencode provider host env passthrough', () => {
  it('forwards OPENCODE_IDLE_TIMEOUT_MS from hostEnv into the container env', () => {
    const configFn = getProviderContainerConfig('opencode');
    expect(configFn).toBeDefined();

    const contribution = configFn!({
      sessionDir: '/tmp/opencode-env-test-session',
      agentGroupId: 'ag-test',
      groupDir: '/tmp/opencode-env-test-group',
      selectedSkills: [],
      hostEnv: {
        OPENCODE_PROVIDER: 'lmstudio',
        OPENCODE_MODEL: 'lmstudio/test-model',
        OPENCODE_SMALL_MODEL: 'lmstudio/test-model',
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:1234/v1',
        OPENCODE_IDLE_TIMEOUT_MS: '900000',
      },
    });

    expect(contribution.env?.OPENCODE_IDLE_TIMEOUT_MS).toBe('900000');
  });
});
