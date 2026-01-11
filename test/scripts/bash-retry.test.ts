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

  describe('retry_command_timeout function', () => {
    test('contains retry_command_timeout function', () => {
      expect(retryFunctions).toContain('retry_command_timeout()');
    });

    test('takes timeout_seconds as first argument', () => {
      expect(retryFunctions).toContain('local timeout_seconds=$1');
      expect(retryFunctions).toContain('shift');
    });

    test('uses timeout command to wrap execution', () => {
      expect(retryFunctions).toContain('timeout $timeout_seconds "$@"');
    });

    test('handles timeout exit code 124', () => {
      expect(retryFunctions).toContain('exit_code -eq 124');
      expect(retryFunctions).toContain('failure_reason="timeout"');
    });

    test('handles killed exit code 137', () => {
      expect(retryFunctions).toContain('exit_code -eq 137');
      expect(retryFunctions).toContain('failure_reason="killed"');
    });

    test('includes jitter for thundering herd prevention', () => {
      // Extract retry_command_timeout function body
      const timeoutFnMatch = retryFunctions.match(
        /retry_command_timeout\(\)[\s\S]*?^}$/m
      );
      expect(timeoutFnMatch).toBeTruthy();
      const timeoutFnBody = timeoutFnMatch![0];

      expect(timeoutFnBody).toContain('jitter_max');
      expect(timeoutFnBody).toContain('RANDOM');
      expect(timeoutFnBody).toContain('actual_delay');
    });

    test('logs timeout value in structured logging', () => {
      expect(retryFunctions).toContain('timeout_seconds=$timeout_seconds');
    });

    test('logs failure reason in retry message', () => {
      expect(retryFunctions).toContain('reason=$failure_reason');
    });
  });

  describe('retry metrics integration', () => {
    test('checks if emit_metric is available before emitting', () => {
      expect(retryFunctions).toContain('command -v emit_metric >/dev/null 2>&1 && emit_metric');
    });

    test('emits RetryAttempt metric on retry attempts', () => {
      expect(retryFunctions).toContain('emit_metric "RetryAttempt" 1 "Count"');
    });

    test('emits RetryExhausted metric when all retries fail', () => {
      expect(retryFunctions).toContain('emit_metric "RetryExhausted" 1 "Count"');
    });

    test('only emits RetryAttempt after first attempt', () => {
      // Should check attempt > 1 before emitting
      expect(retryFunctions).toContain('if [ $attempt -gt 1 ]');
    });

    test('retry_command has RetryAttempt emission', () => {
      // Extract retry_command function body
      const retryCommandMatch = retryFunctions.match(
        /retry_command\(\)[\s\S]*?^}$/m
      );
      expect(retryCommandMatch).toBeTruthy();
      const retryCommandBody = retryCommandMatch![0];

      expect(retryCommandBody).toContain('emit_metric "RetryAttempt"');
      expect(retryCommandBody).toContain('emit_metric "RetryExhausted"');
    });

    test('retry_command_timeout has RetryAttempt emission', () => {
      // Extract retry_command_timeout function body
      const timeoutFnMatch = retryFunctions.match(
        /retry_command_timeout\(\)[\s\S]*?^}$/m
      );
      expect(timeoutFnMatch).toBeTruthy();
      const timeoutFnBody = timeoutFnMatch![0];

      expect(timeoutFnBody).toContain('emit_metric "RetryAttempt"');
      expect(timeoutFnBody).toContain('emit_metric "RetryExhausted"');
    });
  });

  describe('retry_command_output_timeout function', () => {
    test('contains retry_command_output_timeout function', () => {
      expect(retryFunctions).toContain('retry_command_output_timeout()');
    });

    test('takes timeout_seconds as first argument', () => {
      // Both timeout functions should have this pattern
      const matches = retryFunctions.match(/local timeout_seconds=\$1/g);
      expect(matches).toBeTruthy();
      expect(matches!.length).toBeGreaterThanOrEqual(2);
    });

    test('uses timeout command for output capture', () => {
      // Should have pattern: output=$(timeout ...)
      expect(retryFunctions).toContain(
        'output=$(timeout $timeout_seconds "$@" 2>/dev/null)'
      );
    });

    test('includes jitter for thundering herd prevention', () => {
      // Extract retry_command_output_timeout function body
      const outputTimeoutFnMatch = retryFunctions.match(
        /retry_command_output_timeout\(\)[\s\S]*?^}$/m
      );
      expect(outputTimeoutFnMatch).toBeTruthy();
      const outputTimeoutFnBody = outputTimeoutFnMatch![0];

      expect(outputTimeoutFnBody).toContain('jitter_max');
      expect(outputTimeoutFnBody).toContain('RANDOM');
      expect(outputTimeoutFnBody).toContain('actual_delay');
    });

    test('returns output on success', () => {
      expect(retryFunctions).toContain('echo "$output"');
    });
  });
});
