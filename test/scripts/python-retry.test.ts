/**
 * Unit tests for Python retry utilities.
 *
 * These tests validate that getPythonRetryUtils() produces correct Python
 * code with retry_with_backoff function including jitter support.
 */

import { getPythonRetryUtils } from '../../lib/scripts';

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

  describe('CircuitBreaker class', () => {
    test('defines CircuitBreaker class', () => {
      expect(retryUtils).toContain('class CircuitBreaker:');
    });

    test('has failure_threshold parameter with default 5', () => {
      expect(retryUtils).toContain('failure_threshold=5');
    });

    test('has reset_timeout parameter with default 60', () => {
      expect(retryUtils).toContain('reset_timeout=60');
    });

    test('documents three states (CLOSED, OPEN, HALF_OPEN)', () => {
      expect(retryUtils).toContain('CLOSED: Normal operation');
      expect(retryUtils).toContain('OPEN: Service down');
      expect(retryUtils).toContain('HALF_OPEN: Testing if service recovered');
    });

    test('documents state transitions', () => {
      expect(retryUtils).toContain('CLOSED -> OPEN: After failure_threshold');
      expect(retryUtils).toContain('OPEN -> HALF_OPEN: After reset_timeout');
      expect(retryUtils).toContain('HALF_OPEN -> CLOSED: On success');
      expect(retryUtils).toContain('HALF_OPEN -> OPEN: On failure');
    });

    test('has can_execute method', () => {
      expect(retryUtils).toContain('def can_execute(self):');
    });

    test('has record_success method', () => {
      expect(retryUtils).toContain('def record_success(self):');
    });

    test('has record_failure method', () => {
      expect(retryUtils).toContain('def record_failure(self):');
    });

    test('initializes state to CLOSED', () => {
      expect(retryUtils).toContain("self.state = 'CLOSED'");
    });

    test('tracks failure count', () => {
      expect(retryUtils).toContain('self.failures = 0');
      expect(retryUtils).toContain('self.failures += 1');
    });

    test('tracks last failure time', () => {
      expect(retryUtils).toContain('self.last_failure_time = None');
      expect(retryUtils).toContain('self.last_failure_time = time.time()');
    });
  });

  describe('retry metrics integration', () => {
    test('has metrics_logger parameter in retry_with_backoff', () => {
      expect(retryUtils).toContain('metrics_logger=None');
    });

    test('documents metrics_logger parameter in docstring', () => {
      expect(retryUtils).toContain('metrics_logger: Optional MetricsLogger');
    });

    test('emits RetryAttempt metric on retry attempts', () => {
      expect(retryUtils).toContain("metrics_logger.add_metric('RetryAttempt', 1, 'Count')");
    });

    test('emits RetryExhausted metric when all retries fail', () => {
      expect(retryUtils).toContain("metrics_logger.add_metric('RetryExhausted', 1, 'Count')");
    });

    test('only emits RetryAttempt after first attempt', () => {
      expect(retryUtils).toContain('if metrics_logger and attempt > 1:');
    });

    test('includes Operation dimension with operation_name', () => {
      expect(retryUtils).toContain("metrics_logger.add_dimension('Operation', operation_name)");
    });

    test('flushes metrics after emission', () => {
      expect(retryUtils).toContain('metrics_logger.flush()');
    });

    test('metrics are optional (checks if metrics_logger exists)', () => {
      expect(retryUtils).toContain('if metrics_logger:');
    });
  });

  describe('retry_with_circuit_breaker function', () => {
    test('defines retry_with_circuit_breaker function', () => {
      expect(retryUtils).toContain('def retry_with_circuit_breaker(');
    });

    test('has circuit_breaker parameter', () => {
      expect(retryUtils).toContain('circuit_breaker,');
    });

    test('checks circuit breaker before execution', () => {
      expect(retryUtils).toContain('if not circuit_breaker.can_execute():');
    });

    test('fails fast when circuit is open', () => {
      expect(retryUtils).toContain('Circuit breaker OPEN for');
      expect(retryUtils).toContain('failing fast');
    });

    test('calls retry_with_backoff for actual retry logic', () => {
      expect(retryUtils).toContain('result = retry_with_backoff(');
    });

    test('records success on successful result', () => {
      expect(retryUtils).toContain('circuit_breaker.record_success()');
    });

    test('records failure on failed result', () => {
      expect(retryUtils).toContain('circuit_breaker.record_failure()');
    });

    test('documents circuit breaker integration', () => {
      expect(retryUtils).toContain('protected by circuit breaker');
      expect(retryUtils).toContain('Records success/failure to circuit breaker');
    });

    test('has metrics_logger parameter', () => {
      // Verify metrics_logger appears in circuit breaker function signature area
      const cbFnMatch = retryUtils.match(
        /def retry_with_circuit_breaker\([\s\S]*?\):/
      );
      expect(cbFnMatch).toBeTruthy();
      expect(cbFnMatch![0]).toContain('metrics_logger=None');
    });

    test('passes metrics_logger to retry_with_backoff', () => {
      expect(retryUtils).toContain('metrics_logger=metrics_logger');
    });
  });
});
