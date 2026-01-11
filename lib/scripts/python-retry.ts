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
 * Returns Python code string containing retry utility function.
 *
 * The returned string includes:
 * - retry_with_backoff(): Generic retry function with exponential backoff and jitter
 *
 * The function handles:
 * - Exponential backoff (base_delay * 2^attempt)
 * - Jitter to decorrelate retries (configurable factor, default 0.3)
 * - Checking is_retriable attribute on exceptions
 * - Logging of attempts and failures
 *
 * @returns Python code string with retry utility function
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
    retriable_exceptions=(Exception,)
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
    return None
`;
}
