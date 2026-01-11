/**
 * Unit tests for Python retry utilities.
 *
 * These tests validate that getPythonRetryUtils() produces correct Python
 * code with retry_with_backoff function including jitter support.
 */

import { getPythonRetryUtils } from '../../lib/scripts/python-retry';

describe('Python Retry Utils', () => {
  let retryUtils: string;

  beforeAll(() => {
    retryUtils = getPythonRetryUtils();
  });

  describe('function output basics', () => {
    test('returns non-empty string', () => {
      expect(retryUtils).toBeTruthy();
      expect(typeof retryUtils).toBe('string');
      expect(retryUtils.length).toBeGreaterThan(0);
    });
  });

  describe('required imports', () => {
    test('imports random module for jitter', () => {
      expect(retryUtils).toContain('import random');
    });
  });

  describe('function signature', () => {
    test('contains retry_with_backoff function definition', () => {
      expect(retryUtils).toContain('def retry_with_backoff(');
    });

    test('has operation parameter', () => {
      expect(retryUtils).toContain('operation,');
    });

    test('has operation_name parameter', () => {
      expect(retryUtils).toContain('operation_name,');
    });

    test('has max_retries parameter with default 3', () => {
      expect(retryUtils).toContain('max_retries=3');
    });

    test('has base_delay parameter with default 5', () => {
      expect(retryUtils).toContain('base_delay=5');
    });

    test('has jitter_factor parameter with default 0.3', () => {
      expect(retryUtils).toContain('jitter_factor=0.3');
    });

    test('has retriable_exceptions parameter', () => {
      expect(retryUtils).toContain('retriable_exceptions=(Exception,)');
    });
  });

  describe('jitter implementation', () => {
    test('calculates jitter using random.random()', () => {
      expect(retryUtils).toContain('random.random()');
    });

    test('jitter calculation uses jitter_factor', () => {
      expect(retryUtils).toContain('delay * jitter_factor * random.random()');
    });

    test('applies jitter to delay', () => {
      expect(retryUtils).toContain('actual_delay = delay + jitter');
    });

    test('logs jitter breakdown', () => {
      expect(retryUtils).toContain('base:');
      expect(retryUtils).toContain('jitter:');
    });

    test('uses actual_delay for sleep', () => {
      expect(retryUtils).toContain('time.sleep(actual_delay)');
    });
  });

  describe('docstring', () => {
    test('documents jitter_factor parameter', () => {
      expect(retryUtils).toContain('jitter_factor: Random jitter factor');
    });

    test('explains jitter factor percentage', () => {
      expect(retryUtils).toContain('0.3 = up to 30% additional delay');
    });
  });

  describe('exponential backoff', () => {
    test('calculates exponential delay', () => {
      expect(retryUtils).toContain('base_delay * (2 ** (attempt - 1))');
    });
  });

  describe('retry logic', () => {
    test('checks is_retriable attribute', () => {
      expect(retryUtils).toContain("getattr(e, 'is_retriable', True)");
    });

    test('stops on non-retriable errors', () => {
      expect(retryUtils).toContain('if not is_retriable:');
    });

    test('logs attempt numbers', () => {
      expect(retryUtils).toContain('Attempt {attempt}/{max_retries}');
    });

    test('returns None on total failure', () => {
      expect(retryUtils).toContain('return None');
    });
  });
});
