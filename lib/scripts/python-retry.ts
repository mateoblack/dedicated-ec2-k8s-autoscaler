/**
 * Shared Python retry utilities for Lambda functions.
 *
 * This module provides a retry_with_backoff function that can be interpolated
 * into Python Lambda code. It implements exponential backoff retry logic
 * for operations that may fail transiently.
 *
 * Usage in Lambda code generators:
 *   ${getPythonRetryUtils()}
 *
 * Note: The Lambda code should define retriable exception classes with
 * an is_retriable attribute before using this utility.
 */

/**
 * Returns Python code string containing retry utility functions.
 *
 * The returned string includes:
 * - retry_with_backoff(): Generic retry function with exponential backoff and jitter
 * - CircuitBreaker: Class for fail-fast behavior during service outages
 * - retry_with_circuit_breaker(): Retry function protected by circuit breaker
 *
 * The retry function handles:
 * - Exponential backoff (base_delay * 2^attempt)
 * - Jitter to decorrelate retries (configurable factor, default 0.3)
 * - Checking is_retriable attribute on exceptions
 * - Logging of attempts and failures
 *
 * The circuit breaker provides:
 * - Three states: CLOSED (normal), OPEN (fail-fast), HALF_OPEN (testing)
 * - Configurable failure threshold and reset timeout
 * - Automatic state transitions based on success/failure
 *
 * @returns Python code string with retry utility functions
 */
export function getPythonRetryUtils(): string {
  return `
import random

def retry_with_backoff(
    operation,
    operation_name,
    max_retries=3,
    base_delay=5,
    jitter_factor=0.3,
    retriable_exceptions=(Exception,),
    metrics_logger=None
):
    """
    Execute operation with exponential backoff retry logic and jitter.

    Args:
        operation: Callable to execute (no arguments - use closure or functools.partial)
        operation_name: Human-readable name for logging
        max_retries: Maximum number of attempts
        base_delay: Base delay in seconds (exponential: base_delay * 2^attempt)
        jitter_factor: Random jitter factor (0.3 = up to 30% additional delay)
        retriable_exceptions: Tuple of exception types to catch and retry
        metrics_logger: Optional MetricsLogger instance for emitting retry metrics

    Returns:
        Result of operation() on success, or None on failure

    Raises:
        The last exception if operation fails all retries and caller needs it
    """
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"Attempt {attempt}/{max_retries}: {operation_name}")
            return operation()
        except retriable_exceptions as e:
            last_error = e
            is_retriable = getattr(e, 'is_retriable', True)
            logger.warning(f"{operation_name} attempt {attempt} failed: {str(e)}")

            # Emit RetryAttempt metric on each retry (not first attempt)
            if metrics_logger and attempt > 1:
                metrics_logger.add_metric('RetryAttempt', 1, 'Count')
                metrics_logger.add_dimension('Operation', operation_name)
                metrics_logger.flush()

            if not is_retriable:
                logger.error(f"{operation_name} error is not retriable, giving up")
                break

            if attempt < max_retries:
                delay = base_delay * (2 ** (attempt - 1))
                jitter = delay * jitter_factor * random.random()
                actual_delay = delay + jitter
                logger.info(f"Waiting {actual_delay:.1f}s before retry (base: {delay}s, jitter: {jitter:.1f}s)...")
                time.sleep(actual_delay)
        except Exception as e:
            last_error = e
            logger.error(f"Unexpected error in {operation_name} on attempt {attempt}: {str(e)}")
            if attempt < max_retries:
                delay = base_delay
                jitter = delay * jitter_factor * random.random()
                actual_delay = delay + jitter
                time.sleep(actual_delay)

    logger.error(f"All {max_retries} attempts failed for {operation_name}. Last error: {str(last_error)}")

    # Emit RetryExhausted metric when all retries fail
    if metrics_logger:
        metrics_logger.add_metric('RetryExhausted', 1, 'Count')
        metrics_logger.add_dimension('Operation', operation_name)
        metrics_logger.flush()

    return None


class CircuitBreaker:
    """
    Simple circuit breaker for fail-fast behavior during service outages.

    States:
    - CLOSED: Normal operation, requests pass through
    - OPEN: Service down, requests fail immediately
    - HALF_OPEN: Testing if service recovered

    Transitions:
    - CLOSED -> OPEN: After failure_threshold consecutive failures
    - OPEN -> HALF_OPEN: After reset_timeout seconds
    - HALF_OPEN -> CLOSED: On success
    - HALF_OPEN -> OPEN: On failure
    """

    def __init__(self, failure_threshold=5, reset_timeout=60):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.failures = 0
        self.last_failure_time = None
        self.state = 'CLOSED'

    def can_execute(self):
        if self.state == 'CLOSED':
            return True
        if self.state == 'OPEN':
            if time.time() - self.last_failure_time >= self.reset_timeout:
                self.state = 'HALF_OPEN'
                return True
            return False
        return True  # HALF_OPEN

    def record_success(self):
        self.failures = 0
        self.state = 'CLOSED'

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.failure_threshold:
            self.state = 'OPEN'


def retry_with_circuit_breaker(
    operation,
    operation_name,
    circuit_breaker,
    max_retries=3,
    base_delay=5,
    jitter_factor=0.3,
    retriable_exceptions=(Exception,),
    metrics_logger=None
):
    """
    Execute operation with retry logic protected by circuit breaker.

    If circuit is OPEN, fails immediately without attempting operation.
    Records success/failure to circuit breaker for state transitions.

    Args:
        operation: Callable to execute (no arguments - use closure or functools.partial)
        operation_name: Human-readable name for logging
        circuit_breaker: CircuitBreaker instance to check/update state
        max_retries: Maximum number of attempts
        base_delay: Base delay in seconds (exponential: base_delay * 2^attempt)
        jitter_factor: Random jitter factor (0.3 = up to 30% additional delay)
        retriable_exceptions: Tuple of exception types to catch and retry
        metrics_logger: Optional MetricsLogger instance for emitting retry metrics

    Returns:
        Result of operation() on success, or None on failure
    """
    if not circuit_breaker.can_execute():
        logger.warning(f"Circuit breaker OPEN for {operation_name}, failing fast")
        return None

    result = retry_with_backoff(
        operation,
        operation_name,
        max_retries=max_retries,
        base_delay=base_delay,
        jitter_factor=jitter_factor,
        retriable_exceptions=retriable_exceptions,
        metrics_logger=metrics_logger
    )

    if result is not None:
        circuit_breaker.record_success()
    else:
        circuit_breaker.record_failure()

    return result
`;
}
