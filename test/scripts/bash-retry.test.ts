/**
 * Unit tests for bash retry functions with jitter.
 *
 * These tests validate that getBashRetryFunctions() produces correct Bash
 * code with retry logic, exponential backoff, and jitter for thundering herd prevention.
 */

import { getBashRetryFunctions } from '../../lib/scripts/bash-retry';

describe('Bash Retry Functions', () => {
  let retryFunctions: string;

  beforeAll(() => {
    retryFunctions = getBashRetryFunctions();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(retryFunctions).toBeTruthy();
      expect(typeof retryFunctions).toBe('string');
      expect(retryFunctions.length).toBeGreaterThan(0);
    });
  });

  describe('function definitions', () => {
    test('contains retry_command function', () => {
      expect(retryFunctions).toContain('retry_command()');
    });

    test('contains retry_command_output function', () => {
      expect(retryFunctions).toContain('retry_command_output()');
    });
  });

  describe('jitter configuration', () => {
    test('defines JITTER_FACTOR with default value 0.3', () => {
      expect(retryFunctions).toContain('JITTER_FACTOR');
      expect(retryFunctions).toContain('JITTER_FACTOR:=0.3');
    });

    test('documents JITTER_FACTOR in comments', () => {
      expect(retryFunctions).toMatch(/JITTER_FACTOR.*Fraction of delay.*jitter/i);
    });

    test('documents thundering herd prevention', () => {
      expect(retryFunctions).toMatch(/thundering herd/i);
    });
  });

  describe('jitter implementation in retry_command', () => {
    test('uses $RANDOM for randomization', () => {
      expect(retryFunctions).toContain('RANDOM');
    });

    test('calculates jitter_max from delay and JITTER_FACTOR', () => {
      expect(retryFunctions).toContain('jitter_max');
      expect(retryFunctions).toMatch(/jitter_max.*delay.*JITTER_FACTOR/);
    });

    test('calculates actual_delay with jitter', () => {
      expect(retryFunctions).toContain('actual_delay');
      expect(retryFunctions).toMatch(/actual_delay=.*delay.*jitter/);
    });

    test('sleeps for actual_delay (not just delay)', () => {
      expect(retryFunctions).toContain('sleep $actual_delay');
    });

    test('logs jitter in structured logging', () => {
      expect(retryFunctions).toContain('jitter=');
      expect(retryFunctions).toContain('base_delay=');
    });
  });

  describe('jitter implementation in retry_command_output', () => {
    test('uses same jitter pattern as retry_command', () => {
      // Both functions should have jitter calculation
      const jitterMaxMatches = retryFunctions.match(/jitter_max/g);
      expect(jitterMaxMatches).toBeTruthy();
      expect(jitterMaxMatches!.length).toBeGreaterThanOrEqual(2);
    });

    test('retry_command_output includes jitter calculation', () => {
      // Extract retry_command_output function body
      const outputFnMatch = retryFunctions.match(
        /retry_command_output\(\)[\s\S]*?^}/m
      );
      expect(outputFnMatch).toBeTruthy();
      const outputFnBody = outputFnMatch![0];

      expect(outputFnBody).toContain('jitter_max');
      expect(outputFnBody).toContain('RANDOM');
      expect(outputFnBody).toContain('actual_delay');
    });
  });

  describe('exponential backoff', () => {
    test('doubles delay on each retry', () => {
      expect(retryFunctions).toContain('delay=$((delay * 2))');
    });

    test('uses MAX_RETRIES variable', () => {
      expect(retryFunctions).toContain('MAX_RETRIES');
    });

    test('uses RETRY_DELAY variable', () => {
      expect(retryFunctions).toContain('RETRY_DELAY');
    });
  });

  describe('retry_command error handling', () => {
    test('returns 0 on success', () => {
      expect(retryFunctions).toContain('return 0');
    });

    test('returns 1 on failure after all retries', () => {
      expect(retryFunctions).toContain('return 1');
    });

    test('logs error after all retries exhausted', () => {
      expect(retryFunctions).toContain('log_error');
      expect(retryFunctions).toContain('failed after all retries');
    });
  });

  describe('structured logging integration', () => {
    test('checks for log_info availability', () => {
      expect(retryFunctions).toContain('command -v log_info');
    });

    test('checks for log_error availability', () => {
      expect(retryFunctions).toContain('command -v log_error');
    });

    test('falls back to echo when logging not available', () => {
      expect(retryFunctions).toContain('else');
      expect(retryFunctions).toContain('echo');
    });
  });
});
